// Migração one-shot: copia linhas de `templates` do DB ANTIGO -> `linkbio.templates` no DB NOVO.
//
// Uso:
//   OLD_DATABASE_URL="postgres://user:pass@host:port/db" \
//   NEW_DATABASE_URL="postgres://nucleo_admin:...@207.180.231.252:5434/nucleo" \
//   node scripts/migrate-data.mjs
//
// - NEW_DATABASE_URL default = DATABASE_URL do .env.local (se setado no shell).
// - Idempotente: ON CONFLICT (slug) DO UPDATE — pode reexecutar com segurança.
// - Preserva id, slug, created_at, updated_at e o jsonb ctas.
// - SSL desligado em ambos (VPS self-hosted). Ajuste se o DB antigo exigir ssl.

import postgres from 'postgres'

const OLD = process.env.OLD_DATABASE_URL
const NEW = process.env.NEW_DATABASE_URL || process.env.DATABASE_URL
const SCHEMA = 'linkbio'

if (!OLD) { console.error('Faltou OLD_DATABASE_URL'); process.exit(1) }
if (!NEW) { console.error('Faltou NEW_DATABASE_URL (ou DATABASE_URL)'); process.exit(1) }

// DB antigo pode estar em provider gerenciado (Supabase/Neon) que exige SSL.
// Default: tenta sem ssl; se o host contém supabase/neon, liga require.
const oldSsl = /supabase|neon|pooler|amazonaws/i.test(OLD) ? 'require' : false

const oldSql = postgres(OLD, { ssl: oldSsl, max: 1, connect_timeout: 15 })
const newSql = postgres(NEW, { ssl: false, max: 1, connect_timeout: 15 })

const COLS = [
  'id', 'slug', 'name', 'logo_url', 'headline', 'subtitle_html', 'logo_width',
  'accent_color', 'secondary_color', 'template_type', 'logo_href', 'brand_name',
  'handle', 'footer_logo_url', 'footer_logo_href', 'footer_logo_width',
  'footer_copyright', 'ctas', 'created_at', 'updated_at',
]

async function run() {
  // Descobre em qual schema a tabela antiga vive (public por padrão).
  const loc = await oldSql`
    SELECT table_schema FROM information_schema.tables
    WHERE table_name = 'templates' ORDER BY (table_schema='public') DESC LIMIT 1`
  if (!loc.length) { console.error('Tabela `templates` não encontrada no DB antigo'); process.exit(1) }
  const oldSchema = loc[0].table_schema
  console.log(`Lendo de ${oldSchema}.templates ...`)

  const rows = await oldSql`SELECT * FROM ${oldSql(`${oldSchema}.templates`)}`
  console.log(`${rows.length} linha(s) encontrada(s).`)
  if (!rows.length) { console.log('Nada a migrar.'); return }

  let copied = 0
  for (const r of rows) {
    // Só usa colunas que existem na origem; ausentes ficam com default do INSERT.
    const present = COLS.filter((c) => r[c] !== undefined)
    const values = present.map((c) => (c === 'ctas' ? JSON.stringify(r[c] ?? []) : r[c]))
    await newSql`
      INSERT INTO ${newSql(`${SCHEMA}.templates`)} ${newSql(
        Object.fromEntries(present.map((c, i) => [c, values[i]])),
        ...present,
      )}
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        logo_url = EXCLUDED.logo_url,
        headline = EXCLUDED.headline,
        subtitle_html = EXCLUDED.subtitle_html,
        logo_width = EXCLUDED.logo_width,
        accent_color = EXCLUDED.accent_color,
        secondary_color = EXCLUDED.secondary_color,
        template_type = EXCLUDED.template_type,
        logo_href = EXCLUDED.logo_href,
        brand_name = EXCLUDED.brand_name,
        handle = EXCLUDED.handle,
        footer_logo_url = EXCLUDED.footer_logo_url,
        footer_logo_href = EXCLUDED.footer_logo_href,
        footer_logo_width = EXCLUDED.footer_logo_width,
        footer_copyright = EXCLUDED.footer_copyright,
        ctas = EXCLUDED.ctas,
        updated_at = NOW()
    `
    copied++
    console.log(`  ✓ ${r.slug}`)
  }
  console.log(`\nMigração concluída: ${copied}/${rows.length} linha(s).`)

  const total = await newSql`SELECT count(*)::int c FROM ${newSql(`${SCHEMA}.templates`)}`
  console.log(`Total agora em ${SCHEMA}.templates: ${total[0].c}`)
}

run()
  .catch((e) => { console.error('ERRO:', e); process.exitCode = 1 })
  .finally(async () => { await oldSql.end(); await newSql.end() })
