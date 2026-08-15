import { createClient } from "@supabase/supabase-js";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { hasEffectivePermission } from "./_permission.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

export const API_SCOPES = [
  ["meta.read","Read API metadata"],["branches.read","Read branches"],["catalog.read","Read products and units"],
  ["inventory.read","Read branch inventory"],["inventory.cost.read","Read average inventory cost"],
  ["customers.read","Read customers"],["customers.write","Synchronize customers"],["sales.read","Read invoices"],
  ["purchases.read","Read purchase orders"],["online_orders.read","Read online orders"],
  ["online_orders.write","Submit online orders"],["accounting.read","Read accounting journals"]
];
export const WEBHOOK_EVENTS = ["product.created","product.updated","inventory.changed","customer.created","customer.updated","sale.completed","sale.voided","return.completed","online_order.created","online_order.updated","sales_order.updated","purchase.received","integration.test"];

export function serviceClient(){ return createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}); }
export function sha256(value){ return createHash("sha256").update(String(value)).digest("hex"); }
export function randomToken(prefix,bytes=32){ return `${prefix}${randomBytes(bytes).toString("base64url")}`; }
export function hmac(secret,value){ return `sha256=${createHmac("sha256",secret).update(value).digest("hex")}`; }
export function safeEqual(a,b){ const x=Buffer.from(String(a)); const y=Buffer.from(String(b)); return x.length===y.length && timingSafeEqual(x,y); }
export function json(data,status=200,headers={}){ return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}}); }
export function corsHeaders(origin="*"){ return {"Access-Control-Allow-Origin":origin||"*","Access-Control-Allow-Headers":"Authorization, Content-Type, X-API-Key, Idempotency-Key","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Vary":"Origin"}; }
export async function readJson(request){ try{return await request.json();}catch{return {};} }
export function errorMessage(error){ return String(error?.message||error||"Unexpected error"); }

function bearer(request){ const value=request.headers.get("authorization")||""; return value.toLowerCase().startsWith("bearer ")?value.slice(7).trim():""; }
const defaults={"integrations.view":["owner","admin"],"integrations.manage":["owner","admin"],"integrations.keys.manage":["owner","admin"],"integrations.webhooks.manage":["owner","admin"]};
export async function requireUser(request,permission="integrations.view"){
  const token=bearer(request); if(!token || token.startsWith("tpos_live_")) throw Object.assign(new Error("Authentication required"),{status:401});
  const admin=serviceClient(); const {data:userData,error:userError}=await admin.auth.getUser(token);
  if(userError||!userData?.user) throw Object.assign(new Error("Invalid or expired session"),{status:401});
  const {data:profile,error}=await admin.from("profiles").select("id,organization_id,branch_id,full_name,role,is_active").eq("id",userData.user.id).single();
  if(error||!profile?.is_active) throw Object.assign(new Error("Active POS profile required"),{status:403});
  const allowed=await hasEffectivePermission(admin,profile,permission,defaults[permission]||[]);
  if(!allowed) throw Object.assign(new Error(`Permission required: ${permission}`),{status:403});
  return {admin,user:userData.user,profile};
}

function apiKey(request){ const header=request.headers.get("x-api-key")||""; const b=bearer(request); return (header||b).trim(); }
export async function authenticateApi(request){
  const key=apiKey(request); if(!key.startsWith("tpos_live_")) throw Object.assign(new Error("Valid API key required"),{status:401});
  const admin=serviceClient(); const requestId=request.headers.get("x-request-id")||randomUUID();
  const ip=(request.headers.get("x-nf-client-connection-ip")||request.headers.get("x-forwarded-for")||"").split(",")[0].trim();
  const origin=request.headers.get("origin")||null;
  const {data,error}=await admin.rpc("integration_consume_api_key",{p_key_hash:sha256(key),p_request_id:requestId,p_method:request.method,p_request_path:new URL(request.url).pathname,p_ip_hash:ip?sha256(ip):null,p_origin:origin,p_user_agent:request.headers.get("user-agent")});
  if(error) throw error; if(!data?.ok){ const status=data?.error==="rate_limit_exceeded"?429:data?.error==="origin_not_allowed"?403:401; const err=Object.assign(new Error(data?.error||"API authentication failed"),{status,details:data}); throw err; }
  return {admin,auth:data,origin};
}
export function requireScope(auth,scope){ if(!(auth.scopes||[]).includes(scope)) throw Object.assign(new Error(`Scope required: ${scope}`),{status:403}); }
export function allowedBranch(auth,branchId){ const ids=auth.branch_ids||[]; return !branchId || ids.length===0 || ids.includes(branchId); }
export async function finishRequest(admin,auth,status,duration,count=null,branchId=null,error=null){ if(!auth?.request_log_id)return; await admin.rpc("integration_finish_api_request",{p_log_id:auth.request_log_id,p_status_code:status,p_duration_ms:duration,p_response_count:count,p_branch_id:branchId,p_error_message:error}); }

function privateIp(address){
 if(net.isIP(address)===4){ const p=address.split('.').map(Number); return p[0]===10||p[0]===127||p[0]===0||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168); }
 const a=address.toLowerCase(); return a==="::1"||a==="::"||a.startsWith("fc")||a.startsWith("fd")||a.startsWith("fe80:");
}
export async function validateWebhookUrl(value){
 let url; try{url=new URL(String(value));}catch{throw new Error("A valid webhook URL is required");}
 if(url.protocol!=="https:") throw new Error("Webhook URL must use HTTPS");
 if(url.username||url.password) throw new Error("Webhook URL cannot contain credentials");
 const host=url.hostname.toLowerCase(); if(["localhost","localhost.localdomain"].includes(host)||host.endsWith(".local")) throw new Error("Private or local webhook destinations are blocked");
 if(net.isIP(host)&&privateIp(host)) throw new Error("Private or local webhook destinations are blocked");
 const results=await dns.lookup(host,{all:true}); if(!results.length||results.some(r=>privateIp(r.address))) throw new Error("Webhook destination resolves to a private address");
 return url.toString();
}
