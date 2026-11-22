import type { z } from 'zod';
import type { municipality } from '../../packages/contracts/places.ts';
import geography from './assets/catalonia-provinces.json' with { type: 'json' };

type Town = z.infer<typeof municipality>;
type Point = { x: number; y: number };

// Equirectangular projection with the longitude scale fixed at Catalonia's latitude.
function project(longitude: number, latitude: number): Point {
  return { x: longitude * Math.cos((42 * Math.PI) / 180), y: -latitude };
}

const provinces = geography.regions.map(({ rings }, index) => ({
  fill: ['#eee2f6', '#d8e6c5', '#e1edcc', '#f5e6be'][index],
  rings: rings.map(ring => ring.map(([longitude, latitude]) => project(longitude, latitude))),
}));
const bounds = provinces.flatMap(province => province.rings.flat());

function measure(points: Point[]) {
  const west = Math.min(...points.map(({ x }) => x));
  const east = Math.max(...points.map(({ x }) => x));
  const north = Math.min(...points.map(({ y }) => y));
  const south = Math.max(...points.map(({ y }) => y));
  return { centre: { x: (east + west) / 2, y: (north + south) / 2 }, width: east - west, height: south - north };
}

export function mountTownMap(onSelect: (code: string) => void) {
  const frame = document.querySelector<HTMLElement>('#map')!;
  const canvas = frame.querySelector('canvas')!;
  const controls = frame.querySelector<HTMLElement>('.map-controls')!;
  const overlay = document.querySelector<HTMLElement>('#map-pins')!;
  const zoomIn = document.querySelector<HTMLButtonElement>('#zoom-in')!;
  const zoomOut = document.querySelector<HTMLButtonElement>('#zoom-out')!;
  const fit = document.querySelector<HTMLButtonElement>('#fit-map')!;
  const mapSource = document.querySelector<HTMLAnchorElement>('#map-source')!;
  const selectedTown = document.querySelector<HTMLElement>('#map-selection')!;
  mapSource.href = geography.source;
  mapSource.title = `Adapted provincial boundaries · ${geography.dataDate}`;
  document.querySelector<HTMLAnchorElement>('#map-license')!.href = geography.license;

  let pins: { town: Town; position: Point; button: HTMLButtonElement }[] = [];
  let selected: string | null = null;
  let overview = true;
  let zoom = 0;

  function draw() {
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    if (!width || !height) return;
    const density = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(density, density);

    const active = pins.find(({ town }) => town.code === selected);
    selectedTown.textContent = active?.town.name ?? '';
    const view = measure(overview || !pins.length ? bounds : pins.map(({ position }) => position));
    const centre = zoom && active ? active.position : view.centre;
    const scale =
      Math.min((width - 82) / Math.max(0.42, view.width), (height - 78) / Math.max(0.36, view.height)) * 1.5 ** zoom;
    function screen({ x, y }: Point): Point {
      return { x: width / 2 + (x - centre.x) * scale, y: height / 2 + (y - centre.y) * scale };
    }

    for (const province of provinces) {
      ctx.beginPath();
      for (const ring of province.rings) {
        ring.forEach((point, index) => {
          const { x, y } = screen(point);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      ctx.fillStyle = province.fill;
      ctx.strokeStyle = '#a5b394';
      ctx.lineWidth = 1;
      ctx.fill('evenodd');
      ctx.stroke();
    }

    ctx.beginPath();
    for (let longitude = -3; longitude <= 7; longitude += 0.25) {
      const { x } = screen(project(longitude, 42));
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let latitude = 38; latitude <= 45; latitude += 0.25) {
      const { y } = screen(project(2, latitude));
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.strokeStyle = '#53515c23';
    ctx.setLineDash([1.5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const plotted: Point[] = [];
    const clearOfControls = ({ x, y }: Point) =>
      x < controls.offsetLeft - 17 || y > controls.offsetTop + controls.offsetHeight + 17;
    for (const { town, button, position } of pins) {
      const origin = screen(position);
      const visible = origin.x >= 16 && origin.x <= width - 16 && origin.y >= 18 && origin.y <= height - 22;
      button.hidden = !visible;
      button.setAttribute('aria-pressed', String(town.code === selected));
      if (!visible) continue;

      // Keep crowded buttons individually reachable while retaining their true locations.
      let point = origin;
      for (let step = 0; step < 60; step++) {
        if (
          plotted.every(other => Math.hypot(other.x - point.x, other.y - point.y) >= 34) &&
          point.x >= 18 &&
          point.x <= width - 18 &&
          point.y >= 18 &&
          point.y <= height - 23 &&
          clearOfControls(point)
        )
          break;
        const angle = step * 2.4;
        const radius = 15 + 8 * Math.sqrt(step);
        point = { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
      }
      plotted.push(point);
      if (point !== origin) {
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(point.x, point.y);
        ctx.strokeStyle = '#6b5093';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(origin.x, origin.y, 2.5, 0, 2 * Math.PI);
        ctx.fillStyle = '#6b5093';
        ctx.fill();
      }
      button.style.left = `${point.x}px`;
      button.style.top = `${point.y}px`;
    }
    zoomIn.disabled = !pins.length || zoom === 3;
    zoomOut.disabled = zoom === 0;
    fit.disabled = !pins.length;
    fit.textContent = overview ? 'Fit towns' : 'Overview';
  }

  zoomIn.addEventListener('click', () => {
    zoom++;
    draw();
  });
  zoomOut.addEventListener('click', () => {
    zoom--;
    draw();
  });
  fit.addEventListener('click', () => {
    overview = !overview;
    zoom = 0;
    draw();
  });
  new ResizeObserver(draw).observe(frame);

  return {
    setTowns(towns: Town[], shortlist: boolean, ranked = false) {
      selected = null;
      overview = !shortlist;
      zoom = 0;
      pins = towns.map((town, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'map-pin';
        button.title = town.name;
        button.setAttribute('aria-label', `Select ${town.name} on the map`);
        const marker = document.createElement('span');
        marker.className = 'pin-marker';
        marker.setAttribute('aria-hidden', 'true');
        marker.textContent = ranked ? String(index + 1) : '';
        button.append(marker);
        button.addEventListener('click', () => onSelect(town.code));
        return { town, position: project(town.centre.longitude, town.centre.latitude), button };
      });
      overlay.replaceChildren(...pins.map(({ button }) => button));
      draw();
    },
    select(code: string | null) {
      selected = code;
      draw();
    },
  };
}
