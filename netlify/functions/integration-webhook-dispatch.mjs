import { errorMessage, hmac, serviceClient, validateWebhookUrl } from "./_integration-shared.mjs";
export default async()=>{
 const admin=serviceClient();let expanded=0,processed=0,succeeded=0,failed=0;
 try{
  const {data:events,error:eventError}=await admin.from("integration_events").select("*").is("expanded_at",null).order("occurred_at").limit(100);if(eventError)throw eventError;
  for(const event of events||[]){
   const {data:endpoints,error}=await admin.from("integration_webhook_endpoints").select("id,event_types,branch_ids").eq("organization_id",event.organization_id).eq("is_active",true).contains("event_types",[event.event_type]);if(error)throw error;
   const rows=(endpoints||[]).filter(e=>!event.branch_id||!e.branch_ids?.length||e.branch_ids.includes(event.branch_id)).map(e=>({organization_id:event.organization_id,endpoint_id:e.id,event_id:event.id,status:"pending",next_attempt_at:new Date().toISOString()}));
   if(rows.length){const r=await admin.from("integration_webhook_deliveries").upsert(rows,{onConflict:"endpoint_id,event_id",ignoreDuplicates:true});if(r.error)throw r.error;}
   await admin.from("integration_events").update({expanded_at:new Date().toISOString()}).eq("id",event.id);expanded++;
  }
  const {data:due,error:dueError}=await admin.from("integration_webhook_deliveries").select("*,integration_webhook_endpoints(*),integration_events(*)").in("status",["pending","retry"]).lte("next_attempt_at",new Date().toISOString()).order("next_attempt_at").limit(30);if(dueError)throw dueError;
  for(const delivery of due||[]){processed++;const endpoint=delivery.integration_webhook_endpoints;const event=delivery.integration_events;const attempt=Number(delivery.attempt_count||0)+1;const started=Date.now();let statusCode=null,responseExcerpt=null,lastError=null;
   try{
    const url=await validateWebhookUrl(endpoint.endpoint_url);const {data:secret,error}=await admin.from("integration_webhook_secrets").select("signing_secret").eq("endpoint_id",endpoint.id).single();if(error)throw error;
    const body=JSON.stringify({id:event.id,type:event.event_type,occurred_at:event.occurred_at,organization_id:event.organization_id,branch_id:event.branch_id,object:{type:event.object_type,id:event.object_id},data:event.payload});const timestamp=Math.floor(Date.now()/1000).toString();const signature=hmac(secret.signing_secret,`${timestamp}.${body}`);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Number(endpoint.timeout_seconds||10)*1000);
    let response;try{response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json","User-Agent":"TinyPOS-Webhook/1.0","X-TinyPOS-Event":event.event_type,"X-TinyPOS-Delivery":delivery.id,"X-TinyPOS-Timestamp":timestamp,"X-TinyPOS-Signature":signature},body,signal:controller.signal});}finally{clearTimeout(timer);}statusCode=response.status;responseExcerpt=(await response.text()).slice(0,1000);if(!response.ok)throw new Error(`Webhook returned HTTP ${response.status}`);
    await admin.from("integration_webhook_deliveries").update({status:"succeeded",attempt_count:attempt,last_attempt_at:new Date().toISOString(),delivered_at:new Date().toISOString(),response_status:statusCode,response_excerpt:responseExcerpt,error_message:null}).eq("id",delivery.id);
    await admin.from("integration_webhook_endpoints").update({last_success_at:new Date().toISOString()}).eq("id",endpoint.id);succeeded++;
   }catch(error){lastError=errorMessage(error);const dead=attempt>=Number(endpoint?.max_attempts||8);const delay=Math.min(3600,Math.pow(2,Math.min(attempt,10))*30);await admin.from("integration_webhook_deliveries").update({status:dead?"dead":"retry",attempt_count:attempt,last_attempt_at:new Date().toISOString(),next_attempt_at:new Date(Date.now()+delay*1000).toISOString(),response_status:statusCode,response_excerpt:responseExcerpt,error_message:lastError.slice(0,1000)}).eq("id",delivery.id);if(endpoint?.id)await admin.from("integration_webhook_endpoints").update({last_failure_at:new Date().toISOString()}).eq("id",endpoint.id);failed++;}
   await admin.from("integration_webhook_attempts").upsert({organization_id:delivery.organization_id,delivery_id:delivery.id,attempt_number:attempt,status_code:statusCode,duration_ms:Date.now()-started,response_excerpt:responseExcerpt,error_message:lastError},{onConflict:"delivery_id,attempt_number"});
  }
  await admin.from("integration_api_rate_windows").delete().lt("window_started_at",new Date(Date.now()-24*3600*1000).toISOString());
  return new Response(JSON.stringify({ok:true,expanded,processed,succeeded,failed}),{status:200,headers:{"Content-Type":"application/json"}});
 }catch(error){console.error("integration webhook dispatcher",error);return new Response(JSON.stringify({ok:false,error:errorMessage(error)}),{status:500,headers:{"Content-Type":"application/json"}});}
};
