/**
 * Horas úteis. A operação não trabalha à noite nem no fim de semana, então "48 h parada" numa
 * sexta à tarde não significa o mesmo que numa terça. O cálculo em horas úteis desconta o resto.
 *
 * Padrão: segunda a sexta, 08:00 às 18:00, fuso de Brasília (UTC-03:00, sem horário de verão).
 * Configurável por INFOCAIJ_HORARIO_UTIL ("08:00-18:00"), INFOCAIJ_DIAS_UTEIS ("1-5", 1 = segunda,
 * 7 = domingo) e INFOCAIJ_FUSO ("-03:00"). Feriados não são considerados.
 */

export interface Schedule {
  /** Deslocamento do fuso em minutos em relação ao UTC (Brasília = -180). */
  offsetMin: number;
  /** Início e fim do expediente, em minutos desde a meia-noite local. */
  startMin: number;
  endMin: number;
  /** Dias úteis, de 1 (segunda) a 7 (domingo). */
  days: number[];
}

export const DEFAULT_SCHEDULE: Schedule = { offsetMin: -180, startMin: 8 * 60, endMin: 18 * 60, days: [1, 2, 3, 4, 5] };

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

/** Horas úteis entre dois instantes (em milissegundos desde 1970). Zero se `to` não vier depois de `from`. */
export function businessHoursBetween(fromMs: number, toMs: number, schedule: Schedule = DEFAULT_SCHEDULE): number {
  if (!(toMs > fromMs)) return 0;
  // Desloca para o relógio local: a partir daqui, "UTC" significa "hora de parede" do fuso.
  const shift = schedule.offsetMin * MIN_MS;
  const from = fromMs + shift;
  const to = toMs + shift;
  let total = 0;
  for (let day = Math.floor(from / DAY_MS) * DAY_MS; day < to; day += DAY_MS) {
    // getUTCDay: 0 = domingo. Converte para 1 = segunda ... 7 = domingo.
    const weekday = new Date(day).getUTCDay() || 7;
    if (!schedule.days.includes(weekday)) continue;
    const open = day + schedule.startMin * MIN_MS;
    const close = day + schedule.endMin * MIN_MS;
    const overlap = Math.min(to, close) - Math.max(from, open);
    if (overlap > 0) total += overlap;
  }
  return total / 3_600_000;
}

export function describeSchedule(schedule: Schedule): string {
  const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const names = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
  const sign = schedule.offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(schedule.offsetMin);
  const zone = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${schedule.days.map((d) => names[d - 1]).join(', ')}, ${hhmm(schedule.startMin)} às ${hhmm(schedule.endMin)} (${zone}), sem feriados`;
}

function parseTime(text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match || Number(match[1]) > 24 || Number(match[2]) > 59) throw new Error(`Horário inválido: "${text}". Use HH:MM.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Lê o expediente das variáveis de ambiente; o que não for definido usa o padrão. */
export function scheduleFromEnv(env: Record<string, string | undefined>): Schedule {
  const schedule: Schedule = { ...DEFAULT_SCHEDULE, days: [...DEFAULT_SCHEDULE.days] };

  if (env.INFOCAIJ_HORARIO_UTIL) {
    const [start, end] = env.INFOCAIJ_HORARIO_UTIL.split('-');
    if (!start || !end) throw new Error('INFOCAIJ_HORARIO_UTIL deve ter o formato "08:00-18:00".');
    schedule.startMin = parseTime(start);
    schedule.endMin = parseTime(end);
    if (schedule.endMin <= schedule.startMin) throw new Error('INFOCAIJ_HORARIO_UTIL: o fim deve vir depois do início.');
  }

  if (env.INFOCAIJ_DIAS_UTEIS) {
    const days = new Set<number>();
    for (const part of env.INFOCAIJ_DIAS_UTEIS.split(',')) {
      const [a, b = a] = part.trim().split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b > 7 || a > b) {
        throw new Error('INFOCAIJ_DIAS_UTEIS deve ser algo como "1-5" ou "1-5,6" (1 = segunda, 7 = domingo).');
      }
      for (let d = a; d <= b; d++) days.add(d);
    }
    schedule.days = [...days].sort();
  }

  if (env.INFOCAIJ_FUSO) {
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(env.INFOCAIJ_FUSO.trim());
    if (!match) throw new Error('INFOCAIJ_FUSO deve ter o formato "-03:00".');
    schedule.offsetMin = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  }

  return schedule;
}
