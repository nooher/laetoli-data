import { describe, it, expect } from 'vitest';
import { loadConfig, usesCron } from '../config.js';

describe('loadConfig', () => {
  it('defaults to interval mode (daily) when neither cron nor interval set', () => {
    const cfg = loadConfig({});
    expect(usesCron(cfg)).toBe(false);
    expect(cfg.intervalHours).toBe(24);
    expect(cfg.keep).toBe(14);
    expect(cfg.port).toBe(9994);
    expect(cfg.backupDir).toBe('/backups');
  });

  it('uses cron mode when BACKUP_CRON is set', () => {
    const cfg = loadConfig({ BACKUP_CRON: '0 3 * * *' });
    expect(usesCron(cfg)).toBe(true);
    expect(cfg.cron).toBe('0 3 * * *');
    expect(cfg.intervalHours).toBeNull();
  });

  it('cron takes priority over interval', () => {
    const cfg = loadConfig({ BACKUP_CRON: '0 2 * * *', BACKUP_INTERVAL_HOURS: '6' });
    expect(usesCron(cfg)).toBe(true);
  });

  it('honours BACKUP_INTERVAL_HOURS when cron is blank', () => {
    const cfg = loadConfig({ BACKUP_CRON: '', BACKUP_INTERVAL_HOURS: '6' });
    expect(usesCron(cfg)).toBe(false);
    expect(cfg.intervalHours).toBe(6);
  });

  it('honours BACKUP_KEEP and BACKUP_PORT', () => {
    const cfg = loadConfig({ BACKUP_KEEP: '7', BACKUP_PORT: '9000' });
    expect(cfg.keep).toBe(7);
    expect(cfg.port).toBe(9000);
  });
});
