import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { parse } from 'csv-parse/sync';
import { strFromU8, unzipSync } from 'fflate';
import type { Snapshot } from '../../contracts/places.ts';
import { isoDate, railFeed } from '../../contracts/places.ts';
import { madridDate } from '../../places/geography.ts';
import { withDerivedServices } from '../overlay.ts';
import { defineSource } from '../source.ts';
import { coordinates } from '../values.ts';

export const gtfsUrl = 'https://www.fgc.cat/google/google_transit.zip';

/** Lleida is the corridor's destination; it is in the snapshot but is not a recommendable town. */
export const lleidaCode = '251207';

/**
 * The municipality of every stop on the Lleida - la Pobla de Segur lines (RL1, RL2). GTFS has no
 * municipal codes, so this mapping is maintained by hand; a stop missing here fails the refresh.
 */
export const railMunicipalities: Record<string, string> = {
  LE1: lleidaCode,
  LE2: lleidaCode,
  PG1: lleidaCode,
  AT1: '250122',
  VB1: '252542',
  RM1: '252206',
  VF1: '252402',
  BG1: '250404',
  BG2: '250404',
  GB1: '251569',
  SM1: '250621',
  LS1: '250371',
  SN1: '250371',
  AR1: '250024',
  LL1: '259046',
  GT1: '259046',
  PT1: '252347',
  TP1: '252347',
  SD1: '251902',
  PS1: '251713',
};

type Row = Record<string, string>;
const lines = new Set(['RL1', 'RL2']);
const tables = ['feed_info', 'calendar_dates', 'trips', 'stop_times', 'stops'];
/** Rows parsed per turn of the event loop: `stop_times.txt` holds well over 100,000. */
const chunkSize = 5000;

function date(value: string) {
  return isoDate.parse(value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
}

function seconds(time: string) {
  const [h, m, s] = time.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/**
 * Reads the RL1/RL2 timetable out of a GTFS archive. The work is done in slices that give the
 * event loop back in between, so a refresh never holds up a request for the whole parse.
 */
export async function readRail(zip: Uint8Array, asOf: string): Promise<Snapshot['rail']> {
  let hasCalendar = false;
  const archive = unzipSync(zip, {
    filter: file => {
      if (file.name === 'calendar.txt') hasCalendar = true;
      return tables.some(name => file.name === `${name}.txt`);
    },
  });
  await yieldToEventLoop();

  async function table(name: string, keep: (row: Row) => boolean = () => true) {
    const contents = archive[`${name}.txt`];
    if (!contents) throw new Error(`Missing ${name}.txt in FGC feed`);
    const [header, ...body] = strFromU8(contents).replace(/^﻿/, '').split(/\r?\n/);
    const rows: Row[] = [];
    for (let start = 0; start < body.length; start += chunkSize) {
      const chunk = [header, ...body.slice(start, start + chunkSize)].join('\n');
      for (const row of parse(chunk, { columns: true, skip_empty_lines: true }) as Row[]) {
        if (keep(row)) rows.push(row);
      }
      await yieldToEventLoop();
    }
    return rows;
  }

  const [info] = await table('feed_info');
  if (!info) throw new Error('Empty feed_info.txt in FGC feed');
  const feedEnd = date(info.feed_end_date);
  if (asOf < date(info.feed_start_date) || asOf > feedEnd)
    throw new Error('The official FGC feed does not cover today');
  // This feed publishes date-specific additions without calendar.txt. Fail if the format switches.
  if (hasCalendar) throw new Error('FGC service calendar format changed');

  const routes = await table('trips', row => lines.has(row.route_id));
  const serviceIds = new Set(routes.map(row => row.service_id));
  const corridorDates = await table('calendar_dates', row => serviceIds.has(row.service_id));
  if (!corridorDates.length) throw new Error('Missing RL1/RL2 service dates in FGC feed');
  const serviceDates = corridorDates.map(row => date(row.date)).sort();
  const windowStart = serviceDates[0];
  const windowEnd = serviceDates[serviceDates.length - 1];
  if (asOf < windowStart || asOf > windowEnd || windowEnd > feedEnd) {
    throw new Error('Invalid RL1/RL2 schedule coverage');
  }
  const dates: Record<string, string[]> = {};
  for (const row of corridorDates) {
    if (row.exception_type === '1') (dates[date(row.date)] ??= []).push(row.service_id);
  }

  const byTrip = new Map(
    routes.map(row => [
      row.trip_id,
      {
        service: row.service_id,
        line: row.route_id as 'RL1' | 'RL2',
        calls: [] as { sequence: number; call: [string, number, number] }[],
      },
    ]),
  );
  for (const row of await table('stop_times', row => byTrip.has(row.trip_id))) {
    byTrip.get(row.trip_id)?.calls.push({
      sequence: Number(row.stop_sequence),
      call: [row.stop_id, seconds(row.arrival_time), seconds(row.departure_time)],
    });
  }
  const trips = [...byTrip.values()].map(trip => ({
    ...trip,
    calls: trip.calls.sort((a, b) => a.sequence - b.sequence).map(({ call }) => call),
  }));
  const used = new Set(trips.flatMap(trip => trip.calls.map(([stop]) => stop)));
  const stops = (await table('stops', row => used.has(row.stop_id))).map(row => {
    const location = coordinates(row.stop_lat, row.stop_lon);
    if (!location || !railMunicipalities[row.stop_id]) throw new Error(`Unmapped corridor stop: ${row.stop_id}`);
    return { ...location, id: row.stop_id, name: row.stop_name, municipalityCode: railMunicipalities[row.stop_id] };
  });
  return {
    observedAt: info.feed_version,
    sourceUrl: gtfsUrl,
    validFrom: windowStart,
    validThrough: windowEnd,
    dates,
    stops,
    trips,
  };
}

export default defineSource({
  id: 'fgc-gtfs',
  title: 'Horaris GTFS de la línia Lleida - la Pobla de Segur',
  authority: 'Ferrocarrils de la Generalitat de Catalunya (FGC)',
  homepage: 'https://dadesobertes.fgc.cat/',
  ttlMs: 24 * 60 * 60 * 1000,
  schema: railFeed,
  async fetch(context) {
    const response = await context.request(gtfsUrl);
    return readRail(new Uint8Array(await response.arrayBuffer()), madridDate(context.now()));
  },
  // Replaces the timetable as a whole, then recounts the rail stops per municipality.
  overlay: (data, rail) => withDerivedServices({ ...data, snapshot: { ...data.snapshot, rail } }),
});
