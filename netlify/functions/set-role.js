// Changes an existing person's role (owner / editor / viewer). Only an existing
// owner can call this successfully — the service role key never leaves this function.
const { createClient } = require("@supabase/supabase-js");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { userId, role, accessToken } = body;
  if (!userId || !role || !accessToken) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing userId, role, or accessToken" }) };
  }
  if (!["owner", "editor", "viewer"].includes(role)) {
    return { statusCode: 400, body: JSON.stringify({ error: "role must be owner, editor, or viewer" }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server is missing Supabase env vars" }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: callerData, error: callerErr } = await admin.auth.getUser(accessToken);
  if (callerErr || !callerData || !callerData.user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Not authenticated" }) };
  }

  const { data: callerProfile, error: profileErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", callerData.user.id)
    .single();
  if (profileErr || !callerProfile || callerProfile.role !== "owner") {
    return { statusCode: 403, body: JSON.stringify({ error: "Only an owner can change roles" }) };
  }

  const { error: updateErr } = await admin.from("profiles").update({ role }).eq("id", userId);
  if (updateErr) {
    return { statusCode: 400, body: JSON.stringify({ error: updateErr.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
