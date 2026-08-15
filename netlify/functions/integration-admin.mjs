import { API_SCOPES, WEBHOOK_EVENTS, errorMessage, json, randomToken, readJson, requireUser, sha256, validateWebhookUrl } from "./_integration-shared.mjs";

async function workspace(admin,profile){
 const org=profile.organization_id;
 const [branches,clients,endpoints,logs,deliveries,attempts]=await Promise.all([
  admin.from("branches").select("id,name,code,is_active").eq("organization_id",org).order("name"),
  admin.from("integration_api_clients").select("id,name,description,key_prefix,scopes,branch_ids,allowed_origins,rate_limit_per_minute,is_active,expires_at,last_used_at,last_request_path,request_count,revoked_at,created_at,updated_at").eq("organization_id",org).order("created_at",{ascending:false}),
  admin.from("integration_webhook_endpoints").select("id,name,description,endpoint_url,event_types,branch_ids,is_active,timeout_seconds,max_attempts,last_success_at,last_failure_at,created_at,updated_at").eq("organization_id",org).order("created_at",{ascending:false}),
  admin.from("integration_api_request_logs").select("id,client_id,branch_id,request_id,method,request_path,status_code,duration_ms,response_count,origin,error_message,created_at,completed_at").eq("organization_id",org).order("created_at",{ascending:false}).limit(100),
  admin.from("integration_webhook_deliveries").select("id,endpoint_id,event_id,status,attempt_count,next_attempt_at,last_attempt_at,delivered_at,response_status,response_excerpt,error_message,created_at,updated_at,integration_webhook_endpoints(name),integration_events(event_type,object_type,object_id,branch_id,occurred_at)").eq("organization_id",org).order("created_at",{ascending:false}).limit(100),
  admin.from("integration_webhook_attempts").select("id,delivery_id,attempt_number,status_code,duration_ms,response_excerpt,error_message,attempted_at").eq("organization_id",org).order("attempted_at",{ascending:false}).limit(150)
 ]);
 for(const result of [branches,clients,endpoints,logs,deliveries,attempts]) if(result.error) throw result.error;
 return {branches:branches.data||[],clients:clients.data||[],endpoints:endpoints.data||[],logs:logs.data||[],deliveries:deliveries.data||[],attempts:attempts.data||[],scopes:API_SCOPES,event_types:WEBHOOK_EVENTS};
}

export default async (request)=>{
 if(request.method==="OPTIONS") return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Allow-Methods":"POST, OPTIONS"}});
 if(request.method!=="POST") return json({ok:false,error:"Method not allowed"},405);
 try{
  const body=await readJson(request); const action=body.action||"workspace";
  const permission=action==="workspace"||action==="openapi"?"integrations.view":action.includes("client")?"integrations.keys.manage":action.includes("webhook")||action.includes("delivery")?"integrations.webhooks.manage":"integrations.manage";
  const {admin,profile}=await requireUser(request,permission); const org=profile.organization_id;
  if(action==="workspace") return json({ok:true,...await workspace(admin,profile)});
  if(action==="openapi") return json({ok:true,document:openApiDocument(new URL(request.url).origin)});
  if(action==="create-client"){
   const v=body.client||{}; const key=randomToken("tpos_live_"); const prefix=key.slice(0,18);
   const scopes=[...new Set((v.scopes||[]).filter(x=>API_SCOPES.some(([s])=>s===x)))]; if(!scopes.length) throw new Error("Choose at least one API scope");
   const {data,error}=await admin.from("integration_api_clients").insert({organization_id:org,name:String(v.name||"").trim(),description:String(v.description||"").trim()||null,key_prefix:prefix,key_hash:sha256(key),scopes,branch_ids:v.branch_ids||[],allowed_origins:(v.allowed_origins||[]).map(x=>String(x).trim()).filter(Boolean),rate_limit_per_minute:Number(v.rate_limit_per_minute||60),expires_at:v.expires_at||null,created_by:profile.id,updated_by:profile.id}).select("id,name,key_prefix").single(); if(error)throw error;
   return json({ok:true,client:data,secret:key});
  }
  if(action==="rotate-client"){
   const key=randomToken("tpos_live_"); const {data,error}=await admin.from("integration_api_clients").update({key_prefix:key.slice(0,18),key_hash:sha256(key),is_active:true,revoked_at:null,revoked_by:null,updated_by:profile.id,updated_at:new Date().toISOString()}).eq("id",body.client_id).eq("organization_id",org).select("id,name,key_prefix").single(); if(error)throw error; return json({ok:true,client:data,secret:key});
  }
  if(action==="set-client-active"){
   const active=Boolean(body.is_active); const {error}=await admin.from("integration_api_clients").update({is_active:active,revoked_at:active?null:new Date().toISOString(),revoked_by:active?null:profile.id,updated_by:profile.id}).eq("id",body.client_id).eq("organization_id",org); if(error)throw error; return json({ok:true});
  }
  if(action==="create-webhook"){
   const v=body.webhook||{}; const url=await validateWebhookUrl(v.endpoint_url); const events=[...new Set((v.event_types||[]).filter(x=>WEBHOOK_EVENTS.includes(x)))]; if(!events.length)throw new Error("Choose at least one webhook event");
   const secret=randomToken("whsec_"); const {data,error}=await admin.from("integration_webhook_endpoints").insert({organization_id:org,name:String(v.name||"").trim(),description:String(v.description||"").trim()||null,endpoint_url:url,event_types:events,branch_ids:v.branch_ids||[],is_active:v.is_active!==false,timeout_seconds:Number(v.timeout_seconds||10),max_attempts:Number(v.max_attempts||8),created_by:profile.id,updated_by:profile.id}).select("*").single(); if(error)throw error;
   const saved=await admin.from("integration_webhook_secrets").insert({endpoint_id:data.id,organization_id:org,signing_secret:secret}); if(saved.error){await admin.from("integration_webhook_endpoints").delete().eq("id",data.id);throw saved.error;} return json({ok:true,endpoint:data,secret});
  }
  if(action==="update-webhook"){
   const v=body.webhook||{}; const values={updated_by:profile.id};
   for(const key of ["name","description","event_types","branch_ids","is_active","timeout_seconds","max_attempts"]) if(v[key]!==undefined) values[key]=v[key];
   if(v.endpoint_url!==undefined) values.endpoint_url=await validateWebhookUrl(v.endpoint_url);
   const {error}=await admin.from("integration_webhook_endpoints").update(values).eq("id",body.endpoint_id).eq("organization_id",org); if(error)throw error; return json({ok:true});
  }
  if(action==="rotate-webhook-secret"){
   const secret=randomToken("whsec_"); const {error}=await admin.from("integration_webhook_secrets").update({signing_secret:secret,rotated_at:new Date().toISOString()}).eq("endpoint_id",body.endpoint_id).eq("organization_id",org); if(error)throw error; return json({ok:true,secret});
  }
  if(action==="delete-webhook"){
   const {error}=await admin.from("integration_webhook_endpoints").delete().eq("id",body.endpoint_id).eq("organization_id",org); if(error)throw error; return json({ok:true});
  }
  if(action==="test-webhook"){
   const {data:endpoint,error:e}=await admin.from("integration_webhook_endpoints").select("id,branch_ids").eq("id",body.endpoint_id).eq("organization_id",org).single(); if(e)throw e;
   const {error}=await admin.from("integration_events").insert({organization_id:org,branch_id:endpoint.branch_ids?.[0]||profile.branch_id||null,event_type:"integration.test",object_type:"integration",object_id:endpoint.id,payload:{message:"Tiny POS webhook test",requested_by:profile.id,requested_at:new Date().toISOString()}}); if(error)throw error; return json({ok:true});
  }
  if(action==="retry-delivery"){
   const {error}=await admin.from("integration_webhook_deliveries").update({status:"retry",next_attempt_at:new Date().toISOString(),error_message:null,updated_at:new Date().toISOString()}).eq("id",body.delivery_id).eq("organization_id",org).in("status",["dead","retry"]); if(error)throw error; return json({ok:true});
  }
  return json({ok:false,error:"Unknown integration action"},400);
 }catch(error){console.error("integration-admin",error);return json({ok:false,error:errorMessage(error)},error.status||500);}
};

function openApiDocument(origin){ return {openapi:"3.1.0",info:{title:"Tiny POS Integration API",version:"1.0.0"},servers:[{url:`${origin}/api/v1`}],components:{securitySchemes:{ApiKey:{type:"apiKey",in:"header",name:"X-API-Key"}}},security:[{ApiKey:[]}],paths:{"/meta":{get:{summary:"API metadata"}},"/branches":{get:{summary:"Branches"}},"/products":{get:{summary:"Products"}},"/inventory":{get:{summary:"Inventory"}},"/customers":{get:{summary:"Customers"},post:{summary:"Idempotent customer synchronization"}},"/invoices":{get:{summary:"Invoices"}},"/purchase-orders":{get:{summary:"Purchase orders"}},"/online-orders":{get:{summary:"Online orders"},post:{summary:"Idempotent online-order submission"}},"/accounting/journals":{get:{summary:"Accounting journals"}}}}; }
