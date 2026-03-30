import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_KEY = process.env.HUBSPOT_API_KEY;
if (!API_KEY) {
  console.warn('⚠ Missing HUBSPOT_API_KEY — skipping refresh, using existing data if available');
  const dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(path.join(dataDir, 'clients.json'))) {
    fs.writeFileSync(path.join(dataDir, 'clients.json'), '[]', 'utf-8');
  }
  // Still inject Google Client ID even without HubSpot data
  const htmlPath = path.join(ROOT, 'index.html');
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (googleClientId && fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf-8');
    html = html.replaceAll('YOUR_ID.apps.googleusercontent.com', googleClientId);
    fs.writeFileSync(htmlPath, html, 'utf-8');
    console.log('  Google Client ID injected into index.html');
  }
  process.exit(0);
}

// ---------- Brand group detection ----------
const GROUP_PATTERNS = [
  { patterns: ['tealer', 'stormrock', 'neoweed', 'tealerlab'], group: 'Tealer Group' },
  { patterns: ['natulim'], group: 'Natulim' },
  { patterns: ['well.fr', 'lebourget', 'wolf-lingerie'], group: 'CSP Group' },
  { patterns: ['filofax'], group: 'Filofax' },
  { patterns: ['tidoo', 'carryboo', 'naturopera'], group: 'Tidoo Group' },
  { patterns: ['bleucalin', 'willefert'], group: 'Willefert Group' },
  { patterns: ['coucousuzette'], group: 'Coucou Suzette' },
];

function detectGroup(name, domain) {
  const haystack = `${(name || '').toLowerCase()} ${(domain || '').toLowerCase()}`;
  for (const { patterns, group } of GROUP_PATTERNS) {
    if (patterns.some(p => haystack.includes(p))) return group;
  }
  return '';
}

// Also detect groups by hs_parent_company_id (companies sharing a parent)
function assignParentGroups(clients, rawById) {
  // Build parent → children mapping
  const parentMap = new Map();
  for (const [id, raw] of rawById.entries()) {
    const parentId = raw.properties.hs_parent_company_id;
    if (parentId) {
      if (!parentMap.has(parentId)) parentMap.set(parentId, []);
      parentMap.get(parentId).push(id);
    }
  }
  // For groups detected by pattern, propagate to siblings sharing a parent
  const clientById = new Map(clients.map(c => [c._id, c]));
  for (const [parentId, childIds] of parentMap.entries()) {
    const detectedGroup = childIds
      .map(id => clientById.get(id)?.group)
      .find(g => g);
    if (detectedGroup) {
      for (const id of childIds) {
        const c = clientById.get(id);
        if (c && !c.group) c.group = detectedGroup;
      }
      // Also tag the parent itself if it's a client
      const parent = clientById.get(parentId);
      if (parent && !parent.group) parent.group = detectedGroup;
    }
  }
}

// ---------- HubSpot fetch ----------
async function fetchAllCompanies() {
  const url = 'https://api.hubapi.com/crm/v3/objects/companies/search';
  const properties = [
    'name', 'domain', 'website', 'product_category',
    'roi', 'revenue_loyalty', 'revenue_referral', 'mrr_csm',
    'hs_v2_date_entered_customer', 'first_deal_created_date',
    'hs_parent_company_id',
  ];
  const body = {
    filterGroups: [{
      filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }],
    }],
    properties,
    limit: 200,
    after: '0',
  };

  const all = [];
  let page = 1;

  while (true) {
    console.log(`  Fetching page ${page}...`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`HubSpot API error ${res.status}: ${text}`);
      process.exit(1);
    }

    const data = await res.json();
    all.push(...data.results);
    console.log(`  Got ${data.results.length} results (total: ${all.length})`);

    if (data.paging?.next?.after) {
      body.after = data.paging.next.after;
      page++;
    } else {
      break;
    }
  }

  return all;
}

// ---------- Transform ----------
function isZero(v) {
  if (!v) return true;
  const n = parseFloat(v);
  return isNaN(n) || n === 0;
}

function truncDate(v) {
  if (!v) return undefined;
  return v.substring(0, 10);
}

function transform(raw) {
  const p = raw.properties;
  const obj = {
    _id: raw.id,
    name: p.name || '',
    domain: p.domain || '',
    website: p.website || '',
    category: p.product_category || '',
    roi: p.roi || undefined,
    rev_l: isZero(p.revenue_loyalty) ? undefined : p.revenue_loyalty,
    rev_r: isZero(p.revenue_referral) ? undefined : p.revenue_referral,
    mrr: p.mrr_csm || undefined,
    cust_date: truncDate(p.hs_v2_date_entered_customer),
    deal_date: truncDate(p.first_deal_created_date),
    group: detectGroup(p.name, p.domain),
  };
  return obj;
}

function cleanObj(obj) {
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_id') continue; // internal, don't export
    if (v !== undefined && v !== null && v !== '') {
      clean[k] = v;
    }
  }
  return clean;
}

// ---------- HTML regeneration ----------
function regenerateHTML(clients) {
  const htmlPath = path.join(ROOT, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    console.log('  index.html not found, skipping HTML regeneration');
    return;
  }

  let html = fs.readFileSync(htmlPath, 'utf-8');
  const jsonStr = JSON.stringify(clients, null, 2);
  // Replace the CLIENTS array in the HTML
  const regex = /const CLIENTS\s*=\s*\[[\s\S]*?\];/;
  if (regex.test(html)) {
    html = html.replace(regex, `const CLIENTS = ${jsonStr};`);
    console.log('  CLIENTS data injected');
  } else {
    console.log('  Could not find const CLIENTS = [...]; in index.html');
  }

  // Inject Google Client ID if available
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (googleClientId) {
    html = html.replaceAll('YOUR_ID.apps.googleusercontent.com', googleClientId);
    console.log('  Google Client ID injected');
  } else {
    console.warn('  ⚠ GOOGLE_CLIENT_ID not set — keeping placeholder');
  }

  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log('  index.html saved');
}

// ---------- Main ----------
async function main() {
  console.log('Loyoly Dashboard Refresh');
  console.log('========================');
  console.log('');

  console.log('1. Fetching companies from HubSpot...');
  const rawCompanies = await fetchAllCompanies();
  console.log(`   Total companies fetched: ${rawCompanies.length}`);
  console.log('');

  console.log('2. Transforming data...');
  const rawById = new Map(rawCompanies.map(r => [r.id, r]));
  const clients = rawCompanies.map(transform);
  assignParentGroups(clients, rawById);
  const cleaned = clients.map(cleanObj);
  console.log(`   Transformed: ${cleaned.length} clients`);
  console.log('');

  console.log('3. Saving data/clients.json...');
  const dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'clients.json'), JSON.stringify(cleaned, null, 2), 'utf-8');
  console.log('   Saved.');
  console.log('');

  console.log('4. Regenerating index.html...');
  regenerateHTML(cleaned);
  console.log('');

  // Stats
  const withData = cleaned.filter(c =>
    (parseFloat(c.rev_l) || 0) > 0 ||
    (parseFloat(c.rev_r) || 0) > 0 ||
    (parseFloat(c.mrr) || 0) > 0
  );
  const arr = cleaned.reduce((s, c) => s + (parseFloat(c.mrr) || 0) * 12, 0);
  const rev = cleaned.reduce((s, c) => s + (parseFloat(c.rev_l) || 0) + (parseFloat(c.rev_r) || 0), 0);
  const cats = new Set(cleaned.map(c => c.category).filter(Boolean));

  console.log('Stats:');
  console.log(`  Total clients: ${cleaned.length}`);
  console.log(`  With data: ${withData.length}`);
  console.log(`  Categories: ${cats.size}`);
  console.log(`  ARR: ${(arr / 1e6).toFixed(2)}M€`);
  console.log(`  Revenue generated: ${(rev / 1e6).toFixed(2)}M€`);
  console.log('');
  console.log('Done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
