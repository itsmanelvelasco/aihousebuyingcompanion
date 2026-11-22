export const stops = [
  [48, 200],
  [126, 171],
  [208, 113],
  [277, 186],
  [343, 139],
  [421, 75],
];
const waypoints = [
  [
    [74, 200],
    [103, 171],
  ],
  [
    [151, 171],
    [182, 113],
  ],
  [
    [231, 113],
    [252, 186],
  ],
  [
    [304, 186],
    [327, 139],
  ],
  [
    [374, 139],
    [394, 105],
    [421, 105],
  ],
];
const shortcut = [
  [344, 106],
  [371, 76],
];
export const stopNames = ['Start', 'Savings', 'Plan', 'Buy', 'Repay', 'Debt-free'];

export function nextSegment(index: number, useShortcut: boolean) {
  const points = index === 4 && useShortcut ? shortcut : waypoints[index];
  return [stops[index], ...points, stops[index + 1]];
}

export function drawWorld(canvas: HTMLCanvasElement, completed: number, program = '') {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const context = ctx;
  const box = (x: number, y: number, w: number, h: number, color: string) => {
    context.fillStyle = color;
    context.fillRect(x, y, w, h);
  };
  function poly(points: number[][], color: string) {
    context.fillStyle = color;
    context.beginPath();
    for (const [index, [x, y]] of points.entries()) {
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    }
    context.closePath();
    context.fill();
  }
  function line(points: number[][], color: string, width: number, dash: number[] = []) {
    context.lineWidth = width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = color;
    context.setLineDash(dash);
    context.beginPath();
    for (const [index, [x, y]] of points.entries()) {
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    }
    context.stroke();
    context.setLineDash([]);
  }
  function tree(x: number, y: number, size = 1) {
    context.save();
    context.translate(x, y);
    context.scale(size, size);
    box(-8, -1, 18, 4, '#598b7960');
    box(-2, -10, 4, 10, '#81556a');
    poly(
      [
        [-12, -7],
        [-12, -13],
        [-7, -18],
        [-7, -23],
        [7, -23],
        [7, -18],
        [12, -13],
        [12, -7],
      ],
      '#3f957c',
    );
    box(-7, -19, 9, 7, '#6abd91');
    box(-4, -13, 11, 6, '#56a986');
    context.restore();
  }
  function house(x: number, y: number, roof: string, wall: string) {
    box(x - 18, y - 2, 41, 7, '#53437b47');
    box(x - 14, y - 21, 28, 21, wall);
    box(x + 10, y - 20, 5, 20, '#ab83a0');
    poly(
      [
        [x - 20, y - 20],
        [x, y - 38],
        [x + 20, y - 20],
      ],
      roof,
    );
    poly(
      [
        [x - 19, y - 20],
        [x, y - 38],
        [x + 6, y - 32],
        [x - 7, y - 20],
      ],
      '#ffffff38',
    );
    box(x - 3, y - 12, 7, 12, '#695184');
    box(x - 10, y - 15, 5, 5, '#fff2a0');
    box(x + 6, y - 15, 4, 5, '#fff2a0');
  }

  box(0, 0, 480, 260, '#9fd4a7');
  poly(
    [
      [0, 70],
      [48, 49],
      [113, 53],
      [163, 31],
      [218, 47],
      [245, 17],
      [306, 10],
      [344, 39],
      [428, 37],
      [480, 10],
      [480, 0],
      [0, 0],
    ],
    '#c9c1ec',
  );
  poly(
    [
      [0, 70],
      [68, 39],
      [93, 56],
      [145, 12],
      [209, 61],
      [246, 23],
      [300, 53],
      [330, 17],
      [364, 55],
      [432, 30],
      [480, 58],
      [480, 0],
      [0, 0],
    ],
    '#aea3d9',
  );
  poly(
    [
      [103, 44],
      [145, 12],
      [181, 41],
      [153, 33],
      [139, 40],
      [128, 33],
    ],
    '#efe7ff',
  );
  poly(
    [
      [300, 52],
      [330, 17],
      [356, 47],
      [334, 37],
      [324, 40],
      [320, 33],
    ],
    '#f0e7ff',
  );
  poly(
    [
      [0, 225],
      [57, 239],
      [96, 222],
      [160, 237],
      [219, 225],
      [274, 244],
      [351, 216],
      [425, 227],
      [480, 206],
      [480, 260],
      [0, 260],
    ],
    '#86c19a',
  );
  poly(
    [
      [398, 165],
      [435, 158],
      [462, 166],
      [480, 181],
      [480, 228],
      [452, 236],
      [409, 225],
      [389, 206],
      [387, 184],
    ],
    '#72b5c1',
  );
  poly(
    [
      [410, 170],
      [452, 167],
      [480, 193],
      [480, 217],
      [441, 226],
      [410, 213],
      [398, 199],
    ],
    '#91d4da',
  );
  for (const [x, y, w] of [
    [405, 185, 17],
    [438, 199, 21],
    [424, 217, 9],
    [463, 185, 11],
  ])
    box(x, y, w, 2, '#cef2e4');

  for (let index = 0; index < 310; index++) {
    const x = (index * 41 + 11) % 480;
    const y = 57 + ((index * 23 + Math.floor(index / 11) * 19) % 202);
    if (x > 385 && y > 162 && y < 237) continue;
    box(x, y, index % 4 === 0 ? 4 : 2, 2, index % 3 === 0 ? '#79b993' : '#b2dcaf');
    if (index % 11 === 0) box(x, y - 2, 2, 2, index % 2 ? '#f8df8c' : '#f1c2d9');
  }

  const fullRoute = stops.slice(0, -1).flatMap((_, index) => nextSegment(index, false));
  line(fullRoute, '#708e8560', 19);
  line(fullRoute, '#ffebc2', 14);
  line(fullRoute, '#dbb68b', 1.5, [4, 5]);
  if (program === 'offer' || program === 'accepted') {
    const branch = nextSegment(4, true);
    line(branch, '#fff2ba', 13);
    line(branch, '#8551cb', 3, [5, 5]);
  }
  for (let index = 0; index < completed; index++) {
    const segment = nextSegment(index, program === 'accepted');
    line(segment, '#7456d6', 8);
    line(segment, '#b9a0ff', 2);
  }

  for (const [x, y, size] of [
    [15, 126, 1.1],
    [31, 134, 0.85],
    [59, 156, 0.8],
    [88, 115, 0.6],
    [104, 77, 0.8],
    [68, 82, 0.7],
    [265, 79, 1],
    [284, 83, 0.73],
    [303, 68, 0.65],
    [163, 212, 0.9],
    [181, 216, 0.65],
    [224, 238, 1],
    [244, 243, 0.7],
    [334, 222, 0.95],
    [353, 228, 0.7],
    [363, 200, 0.64],
    [473, 114, 1.1],
    [457, 133, 0.7],
    [25, 233, 0.7],
  ])
    tree(x, y, size);

  house(37, 182, '#7f70c8', '#f9cbb9');
  house(128, 142, '#b377a5', '#fadda9');
  house(207, 90, '#6958bb', '#e4d5f3');
  house(221, 102, '#608ca2', '#f4e1c7');
  poly(
    [
      [250, 170],
      [266, 144],
      [277, 170],
    ],
    '#edac76',
  );
  poly(
    [
      [263, 170],
      [266, 144],
      [280, 156],
      [292, 170],
    ],
    '#fbcd8b',
  );
  poly(
    [
      [260, 170],
      [266, 156],
      [273, 170],
    ],
    '#9a6678',
  );
  box(327, 114, 23, 9, '#9f74d1');
  box(334, 98, 8, 24, '#f3d487');
  box(327, 105, 22, 7, '#f3d487');
  house(419, 63, '#a063c6', '#fce8b0');
  house(445, 78, '#cc7dac', '#ffe2bf');
  box(398, 73, 3, 17, '#7c5183');
  box(401, 73, 11, 7, '#ffd877');

  stops.forEach(([x, y], index) => {
    context.beginPath();
    context.arc(x, y, index === completed ? 8 : 6, 0, 2 * Math.PI);
    context.fillStyle = index <= completed ? '#ffe28a' : '#fef8ed';
    context.fill();
    context.strokeStyle = index <= completed ? '#5635b1' : '#896f83';
    context.lineWidth = 2;
    context.stroke();
  });
}

type RouteLane = {
  letter: string;
  upfrontMonths: number | null;
  debtFreeMonths: number | null;
  waypoint?: { label: string; offset: number };
};

export function drawRouteTimeline(canvas: HTMLCanvasElement, lanes: RouteLane[], selected: string, pastMonths: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = Math.max(280, canvas.clientWidth);
  const height = canvas.clientHeight || 340;
  const scale = window.devicePixelRatio || 1;
  canvas.width = width * scale;
  canvas.height = height * scale;
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const left = 35;
  const usable = width - left - 24;
  const x = (progress: number) => left + usable * progress;
  const start = x(0.07),
    today = x(0.23),
    detour = x(0.43),
    mortgage = x(0.62),
    finish = x(0.94);
  const bottom = height - 46;
  const top = 39;
  const horizon = Math.max(300, ...lanes.map(lane => pastMonths + (lane.debtFreeMonths ?? 0))) + 4;
  const y = (months: number) => bottom - (months / horizon) * (bottom - top);
  // The palette of packages/ui/theme.css; a canvas cannot read CSS variables cheaply, so they are repeated here.
  const selectedColor = '#7950a7';
  const doneColor = '#1f7a55';

  function line(color: string, weight: number, points: [number, number][], dash: number[] = []) {
    if (!ctx) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = weight;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function label(value: string, xx: number, yy: number, color: string, bold = false, align: CanvasTextAlign = 'left') {
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.font = `${bold ? 750 : 550} ${bold ? 12 : 11}px system-ui`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(value, xx, yy);
  }

  function stop(xx: number, yy: number, color: string, radius = 5) {
    if (!ctx) return;
    ctx.beginPath();
    ctx.arc(xx, yy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  ctx.fillStyle = '#fffcf5';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#e3f1e5';
  ctx.fillRect(left, 25, today - left, bottom - 25);
  ctx.fillStyle = '#f4ecda';
  ctx.fillRect(mortgage, 25, width - mortgage, bottom - 25);
  label('Years on the journey', 14, 17, '#55625a', true);
  for (let years = 0; years * 12 <= horizon; years += 5) {
    const level = y(years * 12);
    label(`${years}y`, 9, level, '#55625a');
    if (years === 0)
      line('#e6dfcd', 1, [
        [left, level],
        [width - 14, level],
      ]);
    else
      line('#cfc8b4', 1, [
        [left, level],
        [left + 8, level],
      ]);
  }
  line(
    '#91bdaf',
    1,
    [
      [today, 28],
      [today, bottom],
    ],
    [3, 5],
  );

  const planned = lanes.filter(lane => lane.upfrontMonths !== null && lane.debtFreeMonths !== null);
  planned.sort((a, b) => Number(a.letter === selected) - Number(b.letter === selected));
  for (const lane of planned) {
    const isSelected = lane.letter === selected;
    const startMortgage = y(pastMonths + lane.upfrontMonths!);
    const finishMortgage = y(pastMonths + lane.debtFreeMonths!);
    const waypointY = y(pastMonths + (lane.waypoint?.offset ?? 0));
    const color = isSelected ? selectedColor : '#a3a797';
    const path: [number, number][] = [[today, y(pastMonths)]];
    if (lane.waypoint) path.push([detour, waypointY]);
    path.push([mortgage, startMortgage], [finish, finishMortgage]);
    line('#fff', isSelected ? 8 : 5, path);
    line(color, isSelected ? 4.5 : 2, path);
    stop(mortgage, startMortgage, color, isSelected ? 5 : 3);
    stop(finish, finishMortgage, color, isSelected ? 5 : 3);
    if (lane.waypoint) stop(detour, waypointY, color, isSelected ? 4 : 2.5);
    if (isSelected) {
      const elapsed = pastMonths + lane.debtFreeMonths!;
      label(
        elapsed % 12 ? `${Math.floor(elapsed / 12)}y ${elapsed % 12}m` : `${elapsed / 12} years`,
        finish + 4,
        finishMortgage - 13,
        color,
        true,
        'right',
      );
      if (lane.waypoint) label(lane.waypoint.label, detour, waypointY - 14, color, true, 'center');
    }
  }
  line(doneColor, 4.5, [
    [start, y(0)],
    [today, y(pastMonths)],
  ]);
  stop(start, y(0), doneColor);
  stop(today, y(pastMonths), doneColor, 6);
  label(
    width < 450 ? 'Today' : `Today · year ${pastMonths / 12}`,
    today,
    y(pastMonths) - 14,
    doneColor,
    true,
    'center',
  );
  label('Start saving', start - 10, height - 20, '#22352a', true);
  label(width < 430 ? 'Mortgage' : 'Start mortgage', mortgage, height - 20, '#22352a', true, 'center');
  label(width < 430 ? 'Paid off' : 'Mortgage paid off', width - 11, height - 20, '#22352a', true, 'right');
}
