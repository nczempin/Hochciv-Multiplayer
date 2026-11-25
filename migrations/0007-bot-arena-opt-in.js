exports.up = async db => {
    await db.query('ALTER TABLE users ADD COLUMN "arenaOptIn" boolean NOT NULL DEFAULT false');
};
