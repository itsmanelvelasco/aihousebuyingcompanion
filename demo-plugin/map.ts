export const stops = [[48, 200], [126, 171], [208, 113], [277, 186], [343, 139], [421, 75]];
const waypoints = [
  [[74, 200], [103, 171]], [[151, 171], [182, 113]], [[231, 113], [252, 186]],
  [[304, 186], [327, 139]], [[374, 139], [394, 105], [421, 105]]
];
const shortcut = [[344, 106], [371, 76]];
export const stopNames = ['Start', 'Savings', 'Plan', 'Buy', 'Repay', 'Debt-free'];

export function nextSegment(index: number, useShortcut: boolean) {
  const points = index === 4 && useShortcut ? shortcut : waypoints[index];
  return [stops[index], ...points, stops[index + 1]];
}

export function drawWorld(canvas: HTMLCanvasElement, completed: number, program = "") {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const context = ctx;
  const box = (x: number, y: number, w: number, h: number, color: string) => { context.fillStyle = color; context.fillRect(x, y, w, h); };
  function poly(points: number[][], color: string) {
    context.fillStyle = color;
    context.beginPath();
    points.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
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
    points.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
    context.stroke();
    context.setLineDash([]);
  }
  function tree(x: number, y: number, size = 1) {
    context.save();
    context.translate(x, y);
    context.scale(size, size);
    box(-8, -1, 18, 4, '#598b7960');
    box(-2, -10, 4, 10, '#81556a');
    poly([[-12, -7], [-12, -13], [-7, -18], [-7, -23], [7, -23], [7, -18], [12, -13], [12, -7]], '#3f957c');
    box(-7, -19, 9, 7, '#6abd91');
    box(-4, -13, 11, 6, '#56a986');
    context.restore();
  }
  function house(x: number, y: number, roof: string, wall: string) {
    box(x - 18, y - 2, 41, 7, '#53437b47');
    box(x - 14, y - 21, 28, 21, wall);
    box(x + 10, y - 20, 5, 20, '#ab83a0');
    poly([[x - 20, y - 20], [x, y - 38], [x + 20, y - 20]], roof);
    poly([[x - 19, y - 20], [x, y - 38], [x + 6, y - 32], [x - 7, y - 20]], '#ffffff38');
    box(x - 3, y - 12, 7, 12, '#695184');
    box(x - 10, y - 15, 5, 5, '#fff2a0');
    box(x + 6, y - 15, 4, 5, '#fff2a0');
  }

  box(0, 0, 480, 260, '#9fd4a7');
  poly([[0, 70], [48, 49], [113, 53], [163, 31], [218, 47], [245, 17], [306, 10], [344, 39], [428, 37], [480, 10], [480, 0], [0, 0]], '#c9c1ec');
  poly([[0, 70], [68, 39], [93, 56], [145, 12], [209, 61], [246, 23], [300, 53], [330, 17], [364, 55], [432, 30], [480, 58], [480, 0], [0, 0]], '#aea3d9');
  poly([[103, 44], [145, 12], [181, 41], [153, 33], [139, 40], [128, 33]], '#efe7ff');
  poly([[300, 52], [330, 17], [356, 47], [334, 37], [324, 40], [320, 33]], '#f0e7ff');
  poly([[0, 225], [57, 239], [96, 222], [160, 237], [219, 225], [274, 244], [351, 216], [425, 227], [480, 206], [480, 260], [0, 260]], '#86c19a');
  poly([[398, 165], [435, 158], [462, 166], [480, 181], [480, 228], [452, 236], [409, 225], [389, 206], [387, 184]], '#72b5c1');
  poly([[410, 170], [452, 167], [480, 193], [480, 217], [441, 226], [410, 213], [398, 199]], '#91d4da');
  for (const [x, y, w] of [[405, 185, 17], [438, 199, 21], [424, 217, 9], [463, 185, 11]]) box(x, y, w, 2, '#cef2e4');

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

  for (const [x, y, size] of [[15,126,1.1], [31,134,.85], [59,156,.8], [88,115,.6], [104,77,.8], [68,82,.7], [265,79,1], [284,83,.73], [303,68,.65], [163,212,.9], [181,216,.65], [224,238,1], [244,243,.7], [334,222,.95], [353,228,.7], [363,200,.64], [473,114,1.1], [457,133,.7], [25,233,.7]]) tree(x,y,size);

  house(37, 182, '#7f70c8', '#f9cbb9');
  house(128, 142, '#b377a5', '#fadda9');
  house(207, 90, '#6958bb', '#e4d5f3');
  house(221, 102, '#608ca2', '#f4e1c7');
  poly([[250,170], [266,144], [277,170]], '#edac76');
  poly([[263,170], [266,144], [280,156], [292,170]], '#fbcd8b');
  poly([[260,170], [266,156], [273,170]], '#9a6678');
  box(327,114,23,9,'#9f74d1');
  box(334,98,8,24,'#f3d487');
  box(327,105,22,7,'#f3d487');
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

const routePaths: Record<string, { points: number[][]; marker: [number, number] }> = {
  original: { points: [[45, 182], [102, 182], [164, 211], [260, 211], [335, 142], [400, 142], [435, 65]], marker: [254, 211] },
  A: { points: [[45, 182], [94, 113], [185, 68], [267, 50], [352, 50], [435, 65]], marker: [245, 55] },
  B: { points: [[45, 182], [126, 154], [183, 119], [264, 119], [327, 84], [390, 84], [435, 65]], marker: [246, 119] },
  C: { points: [[45, 182], [118, 182], [163, 165], [264, 165], [313, 117], [376, 117], [435, 65]], marker: [242, 165] },
  D: { points: [[45, 182], [97, 79], [159, 43], [205, 29], [342, 29], [435, 65]], marker: [241, 29] },
  E: { points: [[45, 182], [91, 206], [168, 228], [282, 227], [361, 167], [404, 136], [435, 65]], marker: [242, 227] },
};

export function drawRouteMap(canvas: HTMLCanvasElement, letters: string[], highlighted: string) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const region = (color: string, ...points: [number, number][]) => {
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  ctx.fillStyle = '#f0ede3';
  ctx.fillRect(0, 0, 480, 250);
  region('#dfebd9', [0, 0], [203, 0], [181, 61], [85, 102], [0, 105]);
  region('#e5ebd5', [290, 250], [384, 169], [480, 131], [480, 250]);
  region('#d4e5e8', [0, 128], [122, 48], [187, 17], [290, 0], [315, 0], [195, 26], [133, 62], [0, 145]);
  ctx.strokeStyle = '#fffdf5';
  ctx.lineWidth = 4;
  for (const [start, end] of [[5, 110], [64, 212], [130, 244], [194, 313], [251, 373], [329, 436]]) {
    ctx.beginPath();
    ctx.moveTo(start, 6);
    ctx.lineTo(end, 244);
    ctx.stroke();
  }

  const paths = ['original', ...letters].filter(key => routePaths[key]);
  paths.sort((a, b) => Number(a === highlighted) - Number(b === highlighted));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const key of paths) {
    const { points, marker: [x, y] } = routePaths[key];
    const focused = key === highlighted;
    const color = focused ? '#5844cc' : '#727b96';
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const point of points.slice(1)) ctx.lineTo(point[0], point[1]);
    ctx.strokeStyle = '#fffdf5';
    ctx.lineWidth = focused ? 13 : 9;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = focused ? 8 : 4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, focused ? 12 : 10, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(key === 'original' ? '•' : key, x, y);
  }
  for (const [x, y, color] of [[45, 182, '#493798'], [435, 65, '#453763']] as const) {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#fffdf5';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.stroke();
  }
}
