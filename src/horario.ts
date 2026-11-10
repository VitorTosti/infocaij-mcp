/**
 * Horas úteis. A operação não trabalha à noite, no fim de semana nem nos feriados, então "48 h parada"
 * numa sexta à tarde não significa o mesmo que numa terça. O cálculo em horas úteis desconta o resto.
 *
 * Padrão: segunda a sexta, 08:00 às 18:00, fuso de Brasília (UTC-03:00, sem horário de verão), sem
 * expediente nos feriados nacionais. Configurável por INFOCAIJ_HORARIO_UTIL ("08:00-18:00"),
 * INFOCAIJ_DIAS_UTEIS ("1-5", 1 = segunda, 7 = domingo), INFOCAIJ_FUSO ("-03:00"),
 * INFOCAIJ_FERIADOS (datas extras, "2027-02-08,08-20") e INFOCAIJ_FERIADOS_NACIONAIS ("nao" desliga).
 */

export interface Schedule {
  /** Deslocamento do fuso em minutos em relação ao UTC (Brasília = -180). */
  offsetMin: number;
  /** Início e fim do expediente, em minutos desde a meia-noite local. */
  startMin: number;
  endMin: number;
  /** Dias úteis, de 1 (segunda) a 7 (domingo). */
  days: number[];
  /** Desconta os feriados nacionais do Brasil. Ausente conta como não. */
  nationalHolidays?: boolean;
  /** Outras datas sem expediente: "AAAA-MM-DD" (só naquele ano) ou "MM-DD" (todo ano). */
  extraHolidays?: string[];
}

export const DEFAULT_SCHEDULE: Schedule = {
  offsetMin: -180,
  startMin: 8 * 60,
  endMin: 18 * 60,
  days: [1, 2, 3, 4, 5],
  nationalHolidays: true,
  extraHolidays: [],
};

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

const pad = (n: number) => String(n).padStart(2, '0');

// ------------------------------------------------------------------ feriados

/** Feriados nacionais de data fixa (Lei 662/1949, Lei 6.802/1980 e Lei 14.759/2023). */
const FIXED_NATIONAL = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano), em ms UTC. */
export function easterSunday(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

const monthDayOf = (ms: number) => {
  const date = new Date(ms);
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

const nationalCache = new Map<number, Set<string>>();

/** Feriados nacionais de um ano, como "MM-DD": os de data fixa e a Sexta-feira Santa. */
export function nationalHolidays(year: number): Set<string> {
  let set = nationalCache.get(year);
  if (!set) {
    set = new Set([...FIXED_NATIONAL, monthDayOf(easterSunday(year) - 2 * DAY_MS)]);
    nationalCache.set(year, set);
  }
  return set;
}

/** `localDayMs` é a meia-noite do dia no relógio local (já deslocado pelo fuso). */
function isHoliday(localDayMs: number, schedule: Schedule): boolean {
  const year = new Date(localDayMs).getUTCFullYear();
  const monthDay = monthDayOf(localDayMs);
  if (schedule.nationalHolidays && nationalHolidays(year).has(monthDay)) return true;
  const extra = schedule.extraHolidays;
  return !!extra?.length && (extra.includes(monthDay) || extra.includes(`${year}-${monthDay}`));
}

// --------------------------------------------------------------------- cálculo

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
    if (!schedule.days.includes(weekday) || isHoliday(day, schedule)) continue;
    const open = day + schedule.startMin * MIN_MS;
    const close = day + schedule.endMin * MIN_MS;
    const overlap = Math.min(to, close) - Math.max(from, open);
    if (overlap > 0) total += overlap;
  }
  return total / 3_600_000;
}

export function describeSchedule(schedule: Schedule): string {
  const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  const names = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
  const sign = schedule.offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(schedule.offsetMin);
  const zone = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const extra = schedule.extraHolidays?.length ?? 0;
  const parts = [
    schedule.nationalHolidays ? 'sem expediente nos feriados nacionais' : '',
    extra ? `${extra} ${extra === 1 ? 'data extra' : 'datas extras'} sem expediente` : '',
  ].filter(Boolean);
  const holidays = parts.length ? parts.join(' e ') : 'sem descontar feriados';
  return `${schedule.days.map((d) => names[d - 1]).join(', ')}, ${hhmm(schedule.startMin)} às ${hhmm(schedule.endMin)} (${zone}), ${holidays}`;
}

function parseTime(text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match || Number(match[1]) > 24 || Number(match[2]) > 59) throw new Error(`Horário inválido: "${text}". Use HH:MM.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Lê o expediente das variáveis de ambiente; o que não for definido usa o padrão. */
export function scheduleFromEnv(env: Record<string, string | undefined>): Schedule {
  const schedule: Schedule = { ...DEFAULT_SCHEDULE, days: [...DEFAULT_SCHEDULE.days], extraHolidays: [] };

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

  if (env.INFOCAIJ_FERIADOS_NACIONAIS !== undefined) {
    const value = env.INFOCAIJ_FERIADOS_NACIONAIS.trim().toLowerCase();
    if (['nao', 'não', '0', 'false'].includes(value)) schedule.nationalHolidays = false;
    else if (['sim', '1', 'true'].includes(value)) schedule.nationalHolidays = true;
    else throw new Error('INFOCAIJ_FERIADOS_NACIONAIS deve ser "sim" ou "nao".');
  }

  if (env.INFOCAIJ_FERIADOS) {
    for (const part of env.INFOCAIJ_FERIADOS.split(',').map((p) => p.trim()).filter(Boolean)) {
      const match = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(part);
      const month = Number(match?.[2]);
      const day = Number(match?.[3]);
      if (!match || month < 1 || month > 12 || day < 1 || day > 31) {
        throw new Error(`INFOCAIJ_FERIADOS: data inválida "${part}". Use AAAA-MM-DD (uma vez) ou MM-DD (todo ano).`);
      }
      schedule.extraHolidays!.push(part);
    }
  }

  return schedule;
}
