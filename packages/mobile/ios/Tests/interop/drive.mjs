// Drives `CoreChecks interop` (the Swift phone side) with the computer reference
// code in packages/relay. Build the relay first (npm run build there), then:
//   node Tests/interop/drive.mjs <path to CoreChecks binary>
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CommandVerifier, answerHandshake, createIdentity, open, peerKey, publicKeyText, seal } from '../../../../relay/dist/e2e.js';

const bin = process.argv[2];
const child = spawn(bin, ['interop'], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');

const computer = createIdentity();
const hello = await next();
const phoneKey = peerKey(hello.key, hello.id);
send({ key: publicKeyText(computer.publicKey), id: computer.id });

const { hs1 } = await next();
const { env, session } = answerHandshake(computer, phoneKey, hs1);
send({ hs2: env });

const m = await next();
if (m.sid !== session.id) throw new Error('session id differs');
const text = open(session, m.msg).toString('utf8');
if (text !== 'hello from the phone') throw new Error('bad plaintext ' + text);
send({ msg: seal(session, 'hello from the computer') });

const last = await next();
if (last.reply !== 'hello from the computer') throw new Error('phone could not open reply');
const verifier = new CommandVerifier(computer.id);
verifier.addDevice(phoneKey, { lifetimeDays: 30 });
const check = verifier.verify(last.cmd);
if (!check.ok) throw new Error('command refused: ' + JSON.stringify(check));
const again = verifier.verify(last.cmd);
if (again.ok || again.reason !== 'replay') throw new Error('replay not refused');
child.stdin.end();
console.log('interop ok: device id, hs1/hs2, session id, g1.msg both ways, signed command accepted, replay refused');
