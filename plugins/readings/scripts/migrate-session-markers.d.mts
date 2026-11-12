export declare const BACKUP_SUFFIX: string;
export declare function convertMarker(message: Record<string, unknown>): Record<string, unknown>;
export declare function migrateSessionMarkers(dataDir: string, options?: { dryRun?: boolean }): { sessionsScanned: number; sessionsChanged: number; markersConverted: number; skipped: string[] };
