import { getConnection } from "@/modules/database/connection.js";
import { flushLegacySessionNamesToTranscripts } from "@/modules/database/legacy-session-names.js";
import { runMigrations } from "@/modules/database/migrations.js";
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        db.exec(INIT_SCHEMA_SQL);
        console.log('Database schema applied');
        runMigrations(db);
        // Must run before the first synchronizer pass, which would otherwise
        // overwrite the migrated names with titles derived from the transcript.
        await flushLegacySessionNamesToTranscripts(db);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('Database initialization failed', { error: message });
        throw err;
    }
};
