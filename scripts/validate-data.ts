import { loadData } from "../packages/places/data.ts";

const { snapshot, policies } = loadData();
console.log(`Validated ${snapshot.version}: ${snapshot.municipalities.length} municipalities, ${snapshot.schools.length} schools, ${snapshot.rail.trips.length} rail trips, ${policies.length} policies.`);

console.log(`Validated relocation research: ${snapshot.relocation?.municipalities.length ?? 0} municipalities, ${snapshot.relocation?.municipalities.reduce((sum, town) => sum + town.opportunities.length, 0) ?? 0} opportunities.`);
