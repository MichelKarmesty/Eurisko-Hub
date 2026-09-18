import { Injectable, Logger } from '@nestjs/common';
import { CATEGORIES, Category, PRIORITIES, Priority } from '../common/domain';

/**
 * v0.4 — AI-assisted Request Intake (docs/week4-production-ai.md).
 *
 * The employee types a free-form description of their problem and the AI
 * *suggests* the structured fields the New Request form needs: category,
 * priority, a cleaned-up title, and its own confidence (0–1).
 *
 * Three rules shape this service:
 *
 *  1. **Advisory only.** It returns a candidate. It never creates a ticket and
 *     never writes to the database — the employee accepts, edits or ignores the
 *     suggestion, and `POST /tickets` with the existing `CreateTicketDto` stays
 *     the single, unchanged way a ticket is created.
 *  2. **The validator has the final word.** Model output is untrusted input:
 *     `coerceSuggestion()` is the one place a suggestion is built, and it can
 *     only ever emit a category from `CATEGORIES` and a priority from
 *     `PRIORITIES` (common/domain.ts). Garbage in can never reach the caller.
 *  3. **Never block the workflow.** No provider configured, provider down,
 *     timeout, non-JSON answer — every failure is caught and reported as
 *     `{ suggestion: null, error: ... }`, so the form keeps working by hand.
 *
 * Configuration (all optional, read per call so operators and tests can change
 * them without a rebuild):
 *
 *   AI_ENABLED      default true    — set to false to switch the feature off
 *   AI_PROVIDER_URL default http://localhost:11434/v1 (local Ollama)
 *   AI_MODEL        default llama3.2
 *   AI_TIMEOUT_MS   default 5000
 *   AI_API_KEY      default unset   — sent as a bearer token when set
 */

export interface AiIntakeSuggestion {
  category: Category;
  priority: Priority;
  title: string;
  confidence: number;
}

export interface AiIntakeResult {
  suggestion: AiIntakeSuggestion | null;
  error?: string;
}

/** Shape of the OpenAI-compatible chat completion we consume. */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

const DEFAULT_PROVIDER_URL = 'http://localhost:11434/v1';
const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Defaults used when the model returns a value we cannot trust.
 * `IT` is the busiest internal queue and the safest first guess for a broken
 * "thing"; `Medium` keeps urgency neutral — it neither hides a real emergency
 * nor invents one. The employee is expected to correct both.
 */
export const FALLBACK_CATEGORY: Category = 'IT';
export const FALLBACK_PRIORITY: Priority = 'Medium';

/** The prompt asks for exactly the fields we validate, in JSON, with no prose. */
const SYSTEM_PROMPT = [
  "You classify internal support requests for an IT / HR / Maintenance service desk.",
  'Answer with ONLY a JSON object — no prose, no markdown, no code fences:',
  '{"category":"IT"|"HR"|"Maintenance","priority":"Low"|"Medium"|"High","title":"short summary","confidence":0.0}',
  'Rules:',
  '- category must be exactly one of: IT, HR, Maintenance.',
  '- priority must be exactly one of: Low, Medium, High.',
  '- title is a short, neutral summary of the problem (at most 10 words, no quotes).',
  '- confidence is your certainty in the category, a number between 0 and 1.',
  'Examples:',
  '{"category":"IT","priority":"High","title":"Laptop will not turn on","confidence":0.95}',
  '{"category":"HR","priority":"Low","title":"Request for contract copy","confidence":0.9}',
  '{"category":"Maintenance","priority":"Medium","title":"Hallway lighting broken","confidence":0.85}',
].join('\n');

const isCategory = (value: unknown): value is Category =>
  typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);

const isPriority = (value: unknown): value is Priority =>
  typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);

/** A short, human title derived from the employee's own words. */
export function titleFromText(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 8).join(' ');
  const base = words.length > 0 ? words : 'New request';
  const capped = base.length > 80 ? base.slice(0, 80).trim() : base;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

function coerceTitle(value: unknown, sourceText: string): string {
  if (typeof value === 'string') {
    const cleaned = value.replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');
    if (cleaned.length >= 3) return cleaned.slice(0, 120);
  }
  return titleFromText(sourceText);
}

function coerceConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * THE VALIDATION LAYER (docs/week4-production-ai.md §"Why a validation layer").
 *
 * Pure and total: whatever the model returned — `null`, a string, a missing
 * field, `{ "category": "Finance", "priority": "Urgent" }`, a wrong type — this
 * function returns a well-formed suggestion whose category and priority are
 * guaranteed members of the domain enums (common/domain.ts).
 */
export function coerceSuggestion(value: unknown, sourceText: string): AiIntakeSuggestion {
  const record: Record<string, unknown> =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    category: isCategory(record.category) ? record.category : FALLBACK_CATEGORY,
    priority: isPriority(record.priority) ? record.priority : FALLBACK_PRIORITY,
    title: coerceTitle(record.title, sourceText),
    confidence: coerceConfidence(record.confidence),
  };
}

/** Pull the first JSON object out of a model answer, fenced or not. */
export function extractJsonObject(content: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const candidate = (fenced ? fenced[1] : content).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

@Injectable()
export class AiIntakeService {
  private readonly logger = new Logger('AiIntake');

  /** The advisory endpoint itself: always resolves, never throws. */
  async suggest(text: string): Promise<AiIntakeResult> {
    const source = text.trim();

    if (!this.enabled()) {
      return { suggestion: null, error: 'AI suggestions are disabled (AI_ENABLED=false).' };
    }

    try {
      const content = await this.callProvider(source, this.timeoutMs());
      const parsed = extractJsonObject(content);

      if (parsed === null) {
        // The model answered, just not in JSON. A defaults-based suggestion is
        // friendlier than an error: the employee still gets a filled-in form.
        this.logger.warn('AI intake: the provider did not return JSON; using validated defaults.');
        return { suggestion: coerceSuggestion(null, source) };
      }

      return { suggestion: coerceSuggestion(parsed, source) };
    } catch (err) {
      // Provider unreachable, timed out, or answered with an HTTP error. The
      // ticket form must keep working, so this is reported, never thrown.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI intake unavailable: ${message}`);
      return { suggestion: null, error: 'AI provider unavailable' };
    }
  }

  /** One OpenAI-compatible chat completion call. Throws on any failure. */
  private async callProvider(text: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const apiKey = process.env.AI_API_KEY;

    try {
      const res = await fetch(`${this.providerUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model(),
          temperature: 0,
          stream: false,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`AI provider returned HTTP ${res.status}`);

      const data = (await res.json()) as ChatCompletionResponse;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('AI provider returned an empty response');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  private enabled(): boolean {
    return (process.env.AI_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  private providerUrl(): string {
    return (process.env.AI_PROVIDER_URL ?? DEFAULT_PROVIDER_URL).replace(/\/+$/, '');
  }

  private model(): string {
    return process.env.AI_MODEL ?? DEFAULT_MODEL;
  }

  private timeoutMs(): number {
    const parsed = Number(process.env.AI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  }
}
