import { mkdir, writeFile } from 'node:fs/promises';
import { demoNetwork } from '../src/data';
import { validateNetwork } from '../src/engine';
import { branchFromLoop, createPassingLoop, extendServiceTo, usePassingLoop } from '../src/infrastructure';

const network = structuredClone(demoNetwork);
network.id = 'metroweave-advanced-workshop';
network.name = 'Advanced infrastructure workshop';
network.dataStatus = 'demo';
network.description = 'FICTIONAL TRAINING LAYOUT. This is an editable workshop built from the imagined London sandbox, not a passenger map. Finchley Road has invented approach junctions and a separate passing track: the Meridian local uses its platform lane while the express bypasses that platform. A separate orbital branch starts at Paddington, runs one explicit complete lap, leaves for an invented Workshop Junction station, and rejoins the existing ring at Notting Hill Gate. All added infrastructure, junction positions, track alignments, station design settings and operating values are illustrative assumptions. Original geographic inspiration sources are retained; no real passing loop or surveyed railway geometry is claimed.';
network.updatedAt = new Date().toISOString();

const passing = createPassingLoop(network, 'finchleyroad', { serviceId: 'm-local', name: 'Finchley Road training passing loop', lengthMeters: 500, offsetMeters: 80, side: 'left' });
usePassingLoop(network, 'm-local', passing.id, 'main');
usePassingLoop(network, 'm-express', passing.id, 'bypass');

network.stations.push({ id: 'workshop-junction', name: 'Workshop Junction (fictional)', lat: 51.5278, lng: -0.2138, grade: 'above', info: 'Invented training station used to demonstrate leaving and rejoining a ring. This is not a real London station.' });
const branch = branchFromLoop(network, 'o-loop', 'paddington', 1);
branch.id = 'workshop-orbital-branch';
branch.name = 'One lap → Workshop Junction → Notting Hill';
branch.direction = 'forward';
branch.routeId = 'workshop-orbital';
network.routes.push({ id: branch.routeId, name: 'Orbital workshop branch', shortName: 'OB', color: '#167e91', mode: 'metro', visible: true, icon: 'diamond', pattern: 'dash-dot' });
network.services.push(branch);
extendServiceTo(network, branch.id, 'workshop-junction');
extendServiceTo(network, branch.id, 'nottinghill');

const checked = validateNetwork(network);
const output = new URL('../public/data/advanced-workshop.json', import.meta.url);
await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
await writeFile(output, JSON.stringify(checked, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify({ file: 'public/data/advanced-workshop.json', stations: checked.stations.length, tracks: checked.tracks?.length, junctions: checked.junctions?.length, passingLoops: checked.passingLoops?.length, branchOccurrences: branch.stationIds.length, validated: true }) + '\n');
