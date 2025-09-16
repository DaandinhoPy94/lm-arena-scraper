import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // gebruik SERVICE_ROLE, niet ANON
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const ARENAS = [
  'text','webdev','vision','text-to-image','image-edit','search','text-to-video','image-to-video','copilot'
];

const BASE = 'https://lmarena.ai/leaderboard';

function toInt(s) {
  if (s == null) return null;
  const m = String(s).replace(/\./g, '').match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}
function toFloat(s) {
  if (s == null) return null;
  const m = String(s).replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

async function extractTableRows(page) {
  // Probeer eerst <table>, val terug op ARIA-rows
  let rows = await page.locator('table tbody tr').all();
  if (!rows.length) rows = await page.getByRole('row').all();

  const items = [];
  for (const row of rows) {
    const cells = await row.getByRole('cell').all().length
      ? await row.getByRole('cell').all()
      : await row.locator('td, div[role="cell"]').all();

    if (!cells.length) continue;

    const textCells = [];
    for (const c of cells) textCells.push((await c.innerText()).trim().replace(/\s+/g,' '));
    const joined = textCells.join(' | ').toLowerCase();

    // Heuristische filter: echte datarijen bevatten zowel een modelnaam als score en votes
    const hasScore = /\d{3,4}(\.\d+)?/.test(joined);
    const looksLikeHeader = joined.includes('rank') && joined.includes('model');
    if (!hasScore || looksLikeHeader) continue;

    // Basis mapping: Rank(UB) | Model | Score | Votes | Organization | License
    // Door variaties per arena doen we defensief op indexen.
    const rankUB = toInt(textCells[0]);
    // Model kan een link zijn; probeer de anchor tekst
    let model = textCells[1];
    try {
      const a = await row.locator('a[href]').first();
      if (await a.count()) model = (await a.innerText()).trim();
    } catch {}
    const score = toFloat(textCells.find(t => /±/.test(t)) ?? textCells.find(t => /^\d{3,4}/.test(t)));
    const votes = toInt(textCells.find(t => /vote/i.test(t)) ?? textCells[textCells.length - 3] ?? textCells[textCells.length - 2] ?? textCells[textCells.length - 1]);

    // Organization en License opvangen
    const organization = textCells.find(t => /(openai|anthropic|google|meta|alibaba|minimax|mistral|z\.ai|microsoft|tencent|bytedance|cohere|stepfun|perplexity|nvidia|qwen|moonshot|deepseek|gemma|gemini|llama|api|ai|\.com|\.cn|\.co)/i.test(t))
                       ?? null;
    const license = textCells.find(t => /(MIT|Apache|Proprietary|Llama|Open Model|CC-|Gemma)/i.test(t))
                    ?? null;

    items.push({ rankUB, model, score, votes, organization, license });
  }
  return items.filter(r => r.model && r.score);
}

async function scrapeArena(page, slug) {
  const url = `${BASE}/${slug}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // wacht tot de kolomtitel zichtbaar is
  await page.waitForTimeout(1000);
  const rows = await extractTableRows(page);
  return rows.map((r, i) => ({
    arena: slug,
    rank_position: r.rankUB ?? (i + 1),
    model_name: r.model,
    organization: r.organization,
    overall_score: r.score,
    votes: r.votes ?? null,
    license: r.license ?? null,
    source_url: url,
  }));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const scraped_at = new Date().toISOString();

  try {
    for (const slug of ARENAS) {
      try {
        const rows = await scrapeArena(page, slug);
        if (!rows.length) {
          console.warn(`[WARN] Geen rijen voor ${slug}`);
          continue;
        }
        const payload = rows.map(r => ({ ...r, scraped_at, row_json: r }));

        const { error } = await supabase
          .from('lm_arena_leaderboard_snapshots')
          .upsert(payload, { onConflict: 'arena, scraped_at, model_name, rank_position' });

        if (error) {
          console.error(`[ERROR] Upsert ${slug}:`, error);
        } else {
          console.log(`[OK] ${slug}: ${rows.length} rijen`);
        }
      } catch (e) {
        console.error(`[ARENA FAIL] ${slug}: ${e.message}`);
        // Doorgaan met de volgende arena
      }
    }
  } finally {
    await browser.close();
  }
})();
