import type { z } from 'zod';
import type { point } from '../contracts/places.ts';

type Point = z.infer<typeof point>;

export function distanceKm(a: Point, b: Point) {
  const toRadians = Math.PI / 180;
  const latitude = (b.latitude - a.latitude) * toRadians;
  const longitude = (b.longitude - a.longitude) * toRadians;
  const haversine =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(a.latitude * toRadians) * Math.cos(b.latitude * toRadians) * Math.sin(longitude / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export function normalizedName(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function madridDate(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(date);
}

export function nextSchoolDay(asOf: string) {
  const date = new Date(`${asOf}T12:00:00Z`);
  do date.setUTCDate(date.getUTCDate() + 1);
  while ([0, 6].includes(date.getUTCDay()));
  return date.toISOString().slice(0, 10);
}
