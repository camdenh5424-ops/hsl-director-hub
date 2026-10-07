// Invites a new person by email (Supabase sends them a "set your password" email)
// and optionally sets their role. Only an existing owner can call this successfully —
// the service role key never leaves this server-side function.
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

  const { email, role, accessToken } = body;
  if (!email || !accessToken) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing email or accessToken" }) };
  }
  const targetRole = ["owner", "editor", "viewer"].includes(role) ? role : "viewer";

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server is missing Supabase env vars" }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 1. Confirm the caller is signed in.
  const { data: callerData, error: callerErr } = await admin.auth.getUser(accessToken);
  if (callerErr || !callerData || !callerData.user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Not authenticated" }) };
  }

  // 2. Confirm the caller is an owner.
  const { data: callerProfile, error: profileErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", callerData.user.id)
    .single();
  if (profileErr || !callerProfile || callerProfile.role !== "owner") {
    return { statusCode: 403, body: JSON.stringify({ error: "Only an owner can invite people" }) };
  }

  // 3. Invite the new person. Supabase creates their auth user and emails them
  //    a link to set a password; our DB trigger then creates their profile row.
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email);
  if (inviteErr) {
    return { statusCode: 400, body: JSON.stringify({ error: inviteErr.message }) };
  }

  // 4. If a non-default role was requested, set it now.
  if (targetRole !== "viewer" && invited && invited.user && invited.user.id) {
    await admin.from("profiles").update({ role: targetRole }).eq("id", invited.user.id);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
