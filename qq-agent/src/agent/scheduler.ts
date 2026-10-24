/** 距离下次自主行动的毫秒数:在平均间隔的 ±30% 内随机浮动 */
export function nextDelayMs(intervalMinutes: number, rand: () => number = Math.random): number {
  const base = Math.max(intervalMinutes, 1) * 60_000;
  return Math.round(base * (0.7 + rand() * 0.6));
}

/** 是否处在安静时段。起点大于终点表示跨午夜(例如 23 点到 7 点);起点等于终点表示没有安静时段 */
export function inQuietHours(date: Date, startHour: number, endHour: number): boolean {
  const h = date.getHours();
  if (startHour === endHour) return false;
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

export interface SchedulerOptions {
  enabled: () => boolean;
  intervalMinutes: () => number;
  quiet: () => [number, number];
  run: () => Promise<unknown>;
  now?: () => Date;
  log?: (m: string) => void;
}

/** 隔一段随机时间唤醒一次 Agent,让它自己决定要不要做点什么 */
export class Scheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;

  constructor(private o: SchedulerOptions) {}

  start() {
    this.stopped = false;
    this.arm();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private arm() {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick().finally(() => this.arm()), nextDelayMs(this.o.intervalMinutes()));
  }

  /** 到点时检查开关与安静时段,满足条件才真的行动 */
  async tick(): Promise<boolean> {
    if (!this.o.enabled()) return false;
    const [from, to] = this.o.quiet();
    if (inQuietHours((this.o.now ?? (() => new Date()))(), from, to)) return false;
    try {
      await this.o.run();
    } catch (e) {
      (this.o.log ?? console.log)(`[proactive] run failed: ${e}`);
    }
    return true;
  }
}
