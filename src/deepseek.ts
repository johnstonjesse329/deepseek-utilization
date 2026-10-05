import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 300;

export interface BalanceInfo {
  readonly currency: string;
  readonly totalBalance: number;
  readonly grantedBalance: number;
  readonly toppedUpBalance: number;
}

export interface BalanceSnapshot {
  readonly at: number;
  readonly isAvailable: boolean;
  readonly balances: readonly BalanceInfo[];
}

/** Any failure talking to the DeepSeek API, with a message safe to show a user. */
export class DeepSeekError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

/**
 * `GET /user/balance` - the only documented DeepSeek account endpoint. It reports
 * the remaining credit, so ongoing usage is inferred from balance deltas
 * (see `usage.ts`).
 */
export async function fetchBalance(
  baseUrl: string,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BalanceSnapshot> {
  const url = buildBalanceUrl(baseUrl);
  const payload = await getJson(
    url,
    { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
  );
  return parseBalance(payload, Date.now());
}

export function buildBalanceUrl(baseUrl: string): URL {
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    throw new DeepSeekError(`Invalid DeepSeek base URL: ${baseUrl}`);
  }
  return new URL('/user/balance', origin);
}

export function parseBalance(payload: unknown, at: number): BalanceSnapshot {
  if (typeof payload !== 'object' || payload === null) {
    throw new DeepSeekError('Unexpected balance response from DeepSeek.');
  }
  const record = payload as Record<string, unknown>;
  const rawInfos = Array.isArray(record.balance_infos) ? record.balance_infos : [];

  const balances: BalanceInfo[] = [];
  for (const raw of rawInfos) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const info = raw as Record<string, unknown>;
    balances.push({
      currency: typeof info.currency === 'string' && info.currency ? info.currency : 'UNKNOWN',
      totalBalance: toNumber(info.total_balance),
      grantedBalance: toNumber(info.granted_balance),
      toppedUpBalance: toNumber(info.topped_up_balance),
    });
  }

  if (balances.length === 0) {
    throw new DeepSeekError('DeepSeek returned no balance information for this account.');
  }

  return { at, isAvailable: record.is_available !== false, balances };
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getJson(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers: { 'User-Agent': 'peak-rate-clock', ...headers },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new DeepSeekError(describeHttpError(status, body)));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new DeepSeekError('DeepSeek returned a non-JSON response.'));
          }
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new DeepSeekError(`DeepSeek did not respond within ${Math.round(timeoutMs / 1000)}s.`));
    });
    request.on('error', (error: Error) => {
      reject(error instanceof DeepSeekError ? error : new DeepSeekError(describeNetworkError(error)));
    });
    request.end();
  });
}

function describeHttpError(status: number, body: string): string {
  const hint =
    status === 401 || status === 403
      ? ' The API key was rejected - run "Peak Rate Clock: Set DeepSeek API Key" again.'
      : '';
  const detail = body.trim() ? ` ${body.trim().slice(0, MAX_BODY_CHARS)}` : '';
  return `DeepSeek returned HTTP ${status}.${hint}${detail}`;
}

function describeNetworkError(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'Could not reach api.deepseek.com - check your network connection.';
  }
  return `DeepSeek request failed: ${error.message}`;
}
