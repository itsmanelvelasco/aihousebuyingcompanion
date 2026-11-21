import { loadData } from "../packages/places/data.ts";

const { snapshot, policies } = loadData();
console.log(`Validated ${snapshot.version}: ${snapshot.municipalities.length} municipalities, ${snapshot.schools.length} schools, ${snapshot.rail.trips.length} rail trips, ${policies.length} policies.`);
