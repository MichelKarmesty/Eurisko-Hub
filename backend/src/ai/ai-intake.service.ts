import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
 *     timeout, non-JSON answer — every failure is caught and reported, so the
 *     form keeps working by hand.
 *  4. **Offline is labelled offline.** When no model answers, an optional
 *     keyword classifier (`AI_OFFLINE_FALLBACK`, on by default) still produces a
 *     valid suggestion so the capability can be demonstrated anywhere — but the
 *     answer carries `source: 'offline'` and a `notice`, and the UI marks it
 *     "Suggested (offline)". Rules are never passed off as the model's work.
 *     Set `AI_OFFLINE_FALLBACK=false` for the strict `{ suggestion: null,
 *     error }` contract.
 *
 * Configuration (all optional, read per call so operators and tests can change
 * them without a rebuild):
 *
 *   AI_ENABLED      default true    — set to false to switch the feature off
 *   AI_PROVIDER_URL default https://api.groq.com/openai/v1 (Groq, free tier)
 *   AI_MODEL        default openai/gpt-oss-20b (a fast free model on Groq;
 *                   model names change — list them at GET /openai/v1/models)
 *   AI_TIMEOUT_MS   default 15000   — cloud APIs are a little slower than local
 *   AI_API_KEY      required for Groq (free key from console.groq.com); sent as
 *                   `Authorization: Bearer …`. A keyless local provider such as
 *                   Ollama (http://localhost:11434/v1) needs no key at all.
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
  /** Where a suggestion came from: the configured model, or the offline rules. */
  source?: 'ai' | 'offline';
  /** Human-readable explanation, set whenever the offline fallback was used. */
  notice?: string;
}

/** Shape of the OpenAI-compatible chat completion we consume. */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/**
 * Defaults: Groq's free OpenAI-compatible cloud API, so the feature works with
 * nothing installed — only a free API key (console.groq.com). Any other
 * OpenAI-compatible endpoint can be used instead by setting `AI_PROVIDER_URL`
 * (e.g. a local Ollama at http://localhost:11434/v1, which needs no key).
 */
const DEFAULT_PROVIDER_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Defaults used when the model returns a value we cannot trust.
 * `IT` is the busiest internal queue and the safest first guess for a broken
 * "thing"; `Medium` keeps urgency neutral — it neither hides a real emergency
 * nor invents one. The employee is expected to correct both.
 */
export const FALLBACK_CATEGORY: Category = 'IT';
export const FALLBACK_PRIORITY: Priority = 'Medium';

/**
 * The prompt asks for exactly the fields we validate, in JSON, with no prose.
 *
 * The service desk is in Lebanon, so an employee may write in English, Arabic
 * (including Lebanese dialect) or French — sometimes mixed. The prompt therefore
 * asks for the *title* in the employee's own language, while `category` and
 * `priority` stay in English because they are domain enum values, not prose.
 */
export const SYSTEM_PROMPT = [
  'You classify internal support requests for an IT / HR / Maintenance service desk of a company in Lebanon.',
  'The employee may write in English, Arabic (including Lebanese dialect), French, or a mix of them.',
  'Answer with ONLY one JSON object — no prose, no markdown, no code fences:',
  '{"category":"IT"|"HR"|"Maintenance","priority":"Low"|"Medium"|"High","title":"short summary","confidence":0.0}',
  'Rules:',
  '- category is exactly one of: IT, HR, Maintenance.',
  '  IT: computers, laptops, screens, phones, printers, wifi/network, email, accounts, passwords, access, software, servers.',
  '  HR: contracts, payroll, salary, leave/vacation, badges, onboarding/offboarding, benefits, personal details, recruitment.',
  '  Maintenance: air conditioning, heating, electricity, lighting, plumbing/leaks, doors, locks, furniture, elevators, cleaning, the building itself.',
  "  If a device or system is not working -> IT. If it is about a person's record or paperwork -> HR. If it is about the physical place or furniture -> Maintenance.",
  '- priority is exactly one of: Low, Medium, High.',
  '  High when the person cannot work, many people are affected, or it is an outage/emergency.',
  '  Low when there is no rush or it is cosmetic. Otherwise Medium.',
  '- title is a NEW, short, neutral summary of the problem — rewrite it in 3 to 8 words;',
  '  never copy the sentence word-for-word. Keep the SAME language the employee used (Arabic stays Arabic, French stays French).',
  '- confidence is your certainty in the category, a number between 0 and 1.',
  'Examples:',
  '{"category":"IT","priority":"High","title":"Laptop will not turn on","confidence":0.95}',
  '{"category":"HR","priority":"Low","title":"Contract copy request","confidence":0.9}',
  '{"category":"Maintenance","priority":"Medium","title":"Hallway lighting broken","confidence":0.85}',
  '{"category":"IT","priority":"High","title":"اللابتوب ما عم يشتغل","confidence":0.95}',
  '{"category":"HR","priority":"Low","title":"طلب نسخة من العقد","confidence":0.9}',
  '{"category":"Maintenance","priority":"Medium","title":"المكيف ما عم يبرّد","confidence":0.85}',
  '{"category":"IT","priority":"High","title":"Ordinateur ne s\'allume plus","confidence":0.9}',
  '{"category":"Maintenance","priority":"Medium","title":"Climatisation en panne","confidence":0.9}',
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

// ============================================================================
// OFFLINE FALLBACK (docs/week4-production-ai.md §"Offline fallback")
// ============================================================================

/**
 * A deliberately simple keyword classifier used ONLY when the configured model
 * cannot answer, so the capability can be demonstrated on a machine with no
 * model installed (a reviewer's laptop, a locked-down runner).
 *
 * It is **not** an LLM and never pretends to be one: everything it produces is
 * returned with `source: 'offline'` plus a `notice`, and the UI labels it
 * "Suggested (offline)". Its confidence is capped low for the same reason.
 * Set `AI_OFFLINE_FALLBACK=false` for the strict provider-only contract
 * (`{ suggestion: null, error: 'AI provider unavailable' }`).
 */
const OFFLINE_KEYWORDS: Record<Category, readonly string[]> = {
  Maintenance: [
    'ac', 'air condition', 'air conditioning', 'heating', 'radiator', 'leak', 'leaking',
    'plumbing', 'tap', 'sink', 'toilet', 'water', 'electricity', 'electrical', 'light',
    'lights', 'lamp', 'bulb', 'socket', 'power outlet', 'door', 'lock', 'window', 'chair',
    'desk', 'furniture', 'elevator', 'lift', 'cleaning', 'clean', 'carpet', 'paint',
    'wall', 'ceiling', 'roof', 'generator', 'ventilation', 'smell', 'broken glass',
    // Arabic
    'مكيف', 'تكييف', 'تبريد', 'تدفئة', 'برد', 'كهربا', 'كهرباء', 'لمبة', 'ضو', 'ضوء',
    'إنارة', 'انارة', 'تسريب', 'ماء', 'مي', 'حنفية', 'مغسلة', 'حمام', 'باب', 'قفل',
    'شباك', 'كرسي', 'طاولة', 'أثاث', 'اثاث', 'مصعد', 'تنظيف', 'دهان', 'جدار', 'سقف',
    'مولدة', 'رطوبة', 'ريحة', 'صيانة',
    // French (accents are stripped before matching)
    'climatisation', 'clim', 'chauffage', 'fuite', 'eau', 'electricite', 'lumiere',
    'lampe', 'porte', 'serrure', 'fenetre', 'chaise', 'bureau', 'ascenseur', 'nettoyage',
    'peinture', 'mur', 'plafond',
  ],
  HR: [
    'hr', 'human resources', 'contract', 'payroll', 'salary', 'payslip', 'leave',
    'vacation', 'holiday', 'sick day', 'badge', 'id card', 'onboarding', 'offboarding',
    'benefit', 'benefits', 'insurance', 'nssf', 'recruit', 'recruitment', 'resume', 'cv',
    'appraisal', 'training', 'emergency contact', 'personal details', 'bank details',
    'resignation', 'certificate', 'attendance', 'timesheet',
    // Arabic
    'موارد بشرية', 'شؤون الموظفين', 'عقد', 'راتب', 'معاش', 'إجازة', 'اجازة', 'عطلة',
    'شهادة', 'تأمين', 'تامين', 'ضمان', 'بدلات', 'تعيين', 'توظيف', 'استقالة', 'حضور',
    'بصمة', 'كشف حساب', 'بيانات شخصية', 'حساب بنكي', 'بنك', 'مصرف', 'بنكي', 'مكافأة', 'ترقية', 'شؤون',
    // French (accents are stripped before matching)
    'contrat', 'paie', 'salaire', 'conge', 'vacances', 'assurance', 'recrutement',
    'formation', 'demission', 'presence', 'ressources humaines', 'bulletin de paie',
  ],
  IT: [
    'laptop', 'computer', 'pc', 'desktop', 'monitor', 'screen', 'keyboard', 'mouse',
    'printer', 'scanner', 'wifi', 'wi-fi', 'internet', 'network', 'vpn', 'email',
    'outlook', 'password', 'login', 'log in', 'software', 'application', 'app', 'server',
    'database', 'phone', 'headset', 'dock', 'cable', 'usb', 'update', 'upgrade', 'install',
    'access', 'account', 'folder', 'file', 'backup', 'malware', 'virus', 'slow', 'crash',
    'frozen', 'restart', 'system',
    // Arabic
    'لابتوب', 'كمبيوتر', 'حاسوب', 'شاشة', 'كيبورد', 'ماوس', 'طابعة', 'سكانر', 'واي فاي',
    'وايفاي', 'نت', 'إنترنت', 'انترنت', 'شبكة', 'إيميل', 'ايميل', 'بريد', 'باسورد',
    'كلمة سر', 'كلمة المرور', 'تسجيل دخول', 'برنامج', 'تطبيق', 'سيرفر', 'خادم',
    'قاعدة بيانات', 'تلفون', 'هاتف', 'موبايل', 'سماعة', 'كابل', 'ملف', 'مجلد',
    'نسخة احتياطية', 'فيروس', 'بطيء', 'معلق', 'توقف', 'تحديث', 'صلاحية', 'نظام',
    // French (accents are stripped before matching)
    'ordinateur', 'ecran', 'clavier', 'souris', 'imprimante', 'reseau', 'mot de passe',
    'logiciel', 'serveur', 'telephone', 'casque', 'cable', 'fichier', 'dossier',
    'sauvegarde', 'lent', 'plante', 'redemarrer', 'acces', 'compte',
  ],
};

const OFFLINE_HIGH_URGENCY = [
  'cannot work', "can't work", 'cant work', 'unable to work', 'urgent', 'asap',
  'critical', 'outage', 'down', 'not working at all', 'stopped working', 'blocked',
  'whole floor', 'everyone', 'production', 'immediately', 'emergency',
  // Arabic
  'ما فيني اشتغل', 'ما بقدر اشتغل', 'مستعجل', 'بسرعة', 'ضروري', 'طارئ', 'واقف',
  'مخرب', 'الجميع', 'كل الطابق',
  // French
  'urgent', 'urgente', 'en panne', 'bloque', 'immediatement', 'tout le monde',
];

const OFFLINE_LOW_URGENCY = [
  'no rush', 'when you have time', 'whenever', 'minor', 'cosmetic', 'not urgent',
  'low priority', 'eventually', 'small thing', 'nice to have',
  // Arabic
  'ما في استعجال', 'مش مستعجل', 'وقت ما تفضى', 'بسيط', 'ما في عجلة',
  // French
  'pas urgent', 'quand vous avez le temps', 'mineur', 'cosmetique',
];

/**
 * Score how strongly `words` match the normalised text.
 * A multi-word phrase (e.g. "emergency contact") is worth more than a generic
 * single word (e.g. "update"), so a specific phrase wins a tie.
 *
 * Arabic keywords match as substrings because the definite article ("ال") is
 * glued to the front of a word (اللابتوب, المكيف…); Latin keywords need a word
 * boundary so "ac" does not match "place".
 */
function countHits(haystack: string, words: readonly string[]): number {
  let score = 0;
  for (const word of words) {
    const hit = /[\u0600-\u06FF]/.test(word)
      ? haystack.includes(word)
      : haystack.includes(` ${word} `);
    if (hit) score += word.includes(' ') ? 2 : 1;
  }
  return score;
}

/**
 * A rules-based suggestion. Pure and total, like `coerceSuggestion`, and it can
 * only emit values from the domain enums — an unknown text simply falls back to
 * `IT`/`Medium` with a low confidence.
 *
 * Multilingual on purpose (English / Arabic / French, accents stripped): the
 * fallback must stay useful in the languages the employees actually write in.
 */
export function classifyOffline(text: string): AiIntakeSuggestion {
  const haystack = ` ${text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip Latin accents, keep Arabic letters
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

  const scored = CATEGORIES.map((category) => ({
    category,
    score: countHits(haystack, OFFLINE_KEYWORDS[category]),
  }));
  // Strict `>` keeps CATEGORIES order as the tie-breaker (IT first), matching
  // FALLBACK_CATEGORY.
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  const category: Category = best.score > 0 ? best.category : FALLBACK_CATEGORY;

  const high = countHits(haystack, OFFLINE_HIGH_URGENCY);
  const low = countHits(haystack, OFFLINE_LOW_URGENCY);
  const priority: Priority =
    high > 0 && high >= low ? 'High' : low > 0 && low > high ? 'Low' : FALLBACK_PRIORITY;

  // Rules are less certain than a model, and the ceiling says so out loud.
  const confidence = best.score > 0 ? Math.min(0.6, 0.4 + 0.1 * (best.score - 1)) : 0.25;

  return { category, priority, title: titleFromText(text), confidence };
}

@Injectable()
export class AiIntakeService implements OnModuleInit {
  private readonly logger = new Logger('AiIntake');

  /**
   * Say once, at boot, how the AI is configured — so a missing key shows up in
   * the startup log instead of only as a 401 after the first "AI Suggest".
   * The key value itself is never logged.
   */
  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log('AI intake: disabled (AI_ENABLED=false).');
      return;
    }

    const keySet = Boolean(process.env.AI_API_KEY);
    const fallbacks = this.fallbackModels();
    this.logger.log(
      `AI intake: provider=${this.providerUrl()} model=${this.model()} ` +
        `key=${keySet ? 'set' : 'MISSING'}` +
        (fallbacks.length > 0 ? ` fallback=${fallbacks.join(',')}` : '') +
        ` offlineFallback=${this.offlineFallbackEnabled() ? 'on' : 'off'}`,
    );

    if (!keySet && /groq\.(com|cloud)/i.test(this.providerUrl())) {
      this.logger.warn(
        'AI intake: the provider is Groq but AI_API_KEY is empty — every call will ' +
          'return HTTP 401 and fall back to the offline classifier. Set AI_API_KEY ' +
          '(a free key from console.groq.com) in THIS process and restart.',
      );
    }
  }

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
        // The model answered, just not in JSON. The offline classifier gives a
        // better guess than empty defaults, and it is labelled as such.
        this.logger.warn('AI intake: the provider did not return JSON; using the offline classifier.');
        return this.offlineResult(
          source,
          'The AI provider answered in an unexpected format — this suggestion comes from the offline keyword classifier, not from the model.',
        );
      }

      return { suggestion: coerceSuggestion(parsed, source), source: 'ai' };
    } catch (err) {
      // Provider unreachable, timed out, or answered with an HTTP error. The
      // ticket form must keep working, so this is reported, never thrown.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI intake unavailable: ${message}`);

      if (this.offlineFallbackEnabled()) {
        return this.offlineResult(source, this.offlineNotice(message));
      }

      return { suggestion: null, error: 'AI provider unavailable' };
    }
  }

  /**
   * Turn a provider failure into an honest, actionable notice, so the employee
   * (and whoever is configuring it) sees *why* the answer is rules-based instead
   * of a generic "unavailable".
   */
  private offlineNotice(message: string): string {
    const tail = 'This suggestion comes from the offline keyword classifier, not from a model.';
    if (/HTTP 401/.test(message) || /unauthori/i.test(message)) {
      return `The AI provider rejected the request (401) — set AI_API_KEY with a free key from console.groq.com. ${tail}`;
    }
    if (/HTTP 429/.test(message) || /rate.?limit/i.test(message)) {
      return `The AI provider is rate-limited (429) — wait a few seconds and try again. ${tail}`;
    }
    if (/HTTP 404/.test(message) || /model_not_found/i.test(message)) {
      return `The configured AI model is not available (404) — check AI_MODEL (list the free models at GET /openai/v1/models). ${tail}`;
    }
    return `AI provider unavailable — ${tail} See docs/week4-production-ai.md for how to configure one.`;
  }

  /**
   * A rules-based suggestion, always labelled: `source: 'offline'` plus a
   * `notice` the client displays, so an offline answer is never mistaken for
   * the model's work.
   */
  private offlineResult(source: string, notice: string): AiIntakeResult {
    return { suggestion: classifyOffline(source), source: 'offline', notice };
  }

  /**
   * Ask the provider for a classification.
   *
   * Tries the configured model first. If it is rate-limited (429), returns a 5xx,
   * or the network blips, it waits briefly and retries once, then moves on to
   * `AI_FALLBACK_MODEL` (comma-separated) before giving up — so one busy model
   * does not drop the answer to the keyword rules. A rejected `response_format`
   * (HTTP 400) is retried without JSON mode, because the field is valid OpenAI
   * but not every compatible server implements it. A 401/404 is not retried: the
   * key or the model name is wrong.
   */
  private async callProvider(text: string, timeoutMs: number): Promise<string> {
    const models = [this.model(), ...this.fallbackModels()];
    let lastError: unknown = new Error('AI provider unavailable');

    for (const model of models) {
      try {
        return await this.callOnce(text, timeoutMs, true, model);
      } catch (err) {
        lastError = err;
        const message = describe(err);

        if (/HTTP 400/.test(message)) {
          try {
            return await this.callOnce(text, timeoutMs, false, model);
          } catch (retryErr) {
            lastError = retryErr;
          }
        }

        if (this.isRetryable(describe(lastError))) {
          await sleep(this.retryDelayMs());
          try {
            return await this.callOnce(text, timeoutMs, true, model);
          } catch (retryErr) {
            lastError = retryErr;
          }
        }
      }
    }

    throw lastError;
  }

  /** 429/5xx and network failures are worth retrying; a bad key or model is not. */
  private isRetryable(message: string): boolean {
    return (
      /HTTP (429|500|502|503|504)/.test(message) ||
      /rate.?limit|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|aborted|network|socket/i.test(
        message,
      )
    );
  }

  /** A single request. `jsonMode` asks the provider for strict JSON output. */
  private async callOnce(
    text: string,
    timeoutMs: number,
    jsonMode: boolean,
    model: string,
  ): Promise<string> {
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
          model,
          temperature: 0,
          stream: false,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
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

  /** On by default so the capability works with no model installed. */
  private offlineFallbackEnabled(): boolean {
    return (process.env.AI_OFFLINE_FALLBACK ?? 'true').toLowerCase() !== 'false';
  }

  private providerUrl(): string {
    return (process.env.AI_PROVIDER_URL ?? DEFAULT_PROVIDER_URL).replace(/\/+$/, '');
  }

  private model(): string {
    return process.env.AI_MODEL ?? DEFAULT_MODEL;
  }

  /** Extra models to try when the primary one fails (`AI_FALLBACK_MODEL=a,b`). */
  private fallbackModels(): string[] {
    return (process.env.AI_FALLBACK_MODEL ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0 && m !== this.model());
  }

  /** How long to wait before the one retry (`AI_RETRY_DELAY_MS`). */
  private retryDelayMs(): number {
    const parsed = Number(process.env.AI_RETRY_DELAY_MS ?? 1500);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1500;
  }

  private timeoutMs(): number {
    const parsed = Number(process.env.AI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
