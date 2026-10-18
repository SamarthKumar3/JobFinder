import fs from 'node:fs';
import crypto from 'node:crypto';
if(!fs.existsSync('.env'))fs.writeFileSync('.env',fs.readFileSync('.env.example','utf8').replaceAll('CHANGE_ME',crypto.randomBytes(24).toString('hex')));
