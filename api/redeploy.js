export default async function handler(req, res) {
  const hook = process.env.VERCEL_DEPLOY_HOOK;
  if (!hook) {
    return res.status(500).json({ error: 'VERCEL_DEPLOY_HOOK not configured' });
  }

  try {
    const r = await fetch(hook, { method: 'POST' });
    if (!r.ok) {
      return res.status(r.status).json({ error: 'Deploy hook failed' });
    }
    const data = await r.json();
    return res.status(200).json({ ok: true, job: data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
