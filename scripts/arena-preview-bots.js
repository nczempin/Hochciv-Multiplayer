// Run inside the isolated preview server. Pipe its output directly to the round-robin driver.
const { User, sequelize } = require('../models');
const { newToken } = require('../utils/bots');

const entrants = [
    ['LabRushAhead', ['rush-ahead']],
    ['LabRushSafe', ['rush-safe']],
    ['LabArmySafe', ['sealgo-army-safe']],
    ['LabSeal', ['seal']],
    ['LabSmallCities', ['probe-small-cities']],
    ['LabEconomy', ['parity', 'economy']],
];

async function provision() {
    if (process.env.ARENA_PREVIEW !== 'on') throw new Error('This command requires the Arena preview server');
    const results = await sequelize.transaction(async transaction => {
        const [owner] = await User.findOrCreate({
            where: { username: 'LabTournamentOwner' },
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
            await bot.update({ botTokenHash: hash }, { transaction });
            bots.push({ name, args, token });
        }
        return bots;
    });
    process.stdout.write(JSON.stringify(results) + '\n');
}

provision().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => sequelize.close());
