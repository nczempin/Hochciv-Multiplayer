// Run inside the isolated preview server. Pipe its output directly to the round-robin driver.
const { User, sequelize } = require('../models');
const { newToken } = require('../utils/bots');
const { readFileSync } = require('node:fs');

const exampleEntrants = [
    ['LabRushAhead', ['rush-ahead']],
    ['LabRushSafe', ['rush-safe']],
    ['LabArmySafe', ['sealgo-army-safe']],
    ['LabSeal', ['seal']],
    ['LabSmallCities', ['probe-small-cities']],
    ['LabEconomy', ['parity', 'economy']],
];
const optIn = process.argv.includes('--opt-in');
const entrants = optIn ? JSON.parse(readFileSync(0, 'utf8')).map(name => [name, []]) : exampleEntrants;

async function provision() {
    if (process.env.ARENA_PREVIEW !== 'on') throw new Error('This command requires the Arena preview server');
    const results = await sequelize.transaction(async transaction => {
        if (entrants.length !== 6 || new Set(entrants.map(([name]) => name)).size !== 6 ||
            entrants.some(([name]) => typeof name !== 'string' || !/^[a-zA-Z0-9_-]{3,30}$/.test(name))) {
            throw new Error('Supply six distinct bot account names');
        }
        const [owner] = await User.findOrCreate({
            where: { username: optIn ? 'LabFamilyOwner' : 'LabTournamentOwner' },
            defaults: { role: 'botcreator', botLimit: entrants.length, isActive: true },
            transaction,
        });
        if (owner.role !== 'botcreator') throw new Error('The tournament owner is already in use');
        const bots = [];
        for (const [name, args] of entrants) {
            const { token, hash } = newToken();
            const [bot] = await User.findOrCreate({
                where: { username: name },
                defaults: { isActive: true, accountType: 'bot', ownerId: owner.id, botTokenHash: hash },
                transaction,
            });
            if (bot.accountType !== 'bot' || bot.ownerId !== owner.id) throw new Error('Unexpected account: ' + name);
            await bot.update({ botTokenHash: hash, ...(optIn ? { arenaOptIn: true } : {}) }, { transaction });
            bots.push({ name, args, token });
        }
        return bots;
    });
    process.stdout.write(JSON.stringify(results) + '\n');
}

provision().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => sequelize.close());
