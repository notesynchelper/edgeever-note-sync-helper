import type { EdgeEverPlugin, PluginContext } from "./edgeever";
import { clampFrequency, readSettings, SETTING_KEYS } from "./settings";
import { SyncService } from "./sync/service";
import { USER_FACING_TEXT } from "./ui/text";

/** Command ids live in the plugin namespace and are also used by schedules. */
export const SYNC_COMMAND_ID = "com.bijitongbu.note-sync-helper.sync";
export const AUTO_SYNC_SCHEDULE_KEY = "auto-sync";
export const STARTUP_SYNC_DELAY_MS = 3_000;

/**
 * Converts the "sync every N minutes" setting into a cron expression for the
 * desktop scheduler. Minutes are the unit users see; sub-hour values use a
 * step, whole hours use an hourly step, and anything longer runs once a day.
 */
export function frequencyToCron(minutes: number): string | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const rounded = Math.round(minutes);
  if (rounded < 60) return `*/${Math.max(1, rounded)} * * * *`;
  const hours = Math.floor(rounded / 60);
  if (hours < 24) return `0 */${Math.max(1, hours)} * * *`;
  return "0 0 * * *";
}

async function applySchedule(context: PluginContext): Promise<void> {
  const cron = frequencyToCron(clampFrequency(await context.settings.get(SETTING_KEYS.frequency)));
  try {
    if (cron) {
      await context.schedules.upsert({
        key: AUTO_SYNC_SCHEDULE_KEY,
        name: "定时同步",
        commandId: SYNC_COMMAND_ID,
        cronExpression: cron,
        missedRunPolicy: "run-once",
      });
    } else {
      await context.schedules.remove(AUTO_SYNC_SCHEDULE_KEY);
    }
  } catch {
    // The web host has no scheduler at all; background sync is desktop-only.
  }
}

const plugin: EdgeEverPlugin = {
  activate(context) {
    const service = new SyncService({ context });
    const disposers: Array<() => void> = [];

    disposers.push(
      context.commands.register({
        id: SYNC_COMMAND_ID,
        title: USER_FACING_TEXT.command.sync,
        run: async () => {
          await service.run();
        },
      }),
    );

    const startupTimer = setTimeout(() => {
      void readSettings(context)
        .then((settings) => (settings.syncOnStart ? service.run() : undefined))
        .catch(() => undefined);
    }, STARTUP_SYNC_DELAY_MS);
    disposers.push(() => clearTimeout(startupTimer));

    void applySchedule(context).catch(() => undefined);
    disposers.push(
      context.events.on("settings.changed", ({ key }) => {
        if (key !== SETTING_KEYS.frequency) return;
        void applySchedule(context).catch(() => undefined);
      }),
    );

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // a disposed registration must not block the others
        }
      }
    };
  },
};

export default plugin;
