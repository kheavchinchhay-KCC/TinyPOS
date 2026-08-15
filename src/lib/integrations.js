export const INTEGRATION_SCOPES = [
  ["meta.read","API metadata"],["branches.read","Branches"],["catalog.read","Products and units"],
  ["inventory.read","Inventory quantities"],["inventory.cost.read","Inventory average cost"],
  ["customers.read","Customer profiles"],["customers.write","Customer synchronization"],
  ["sales.read","Invoices"],["purchases.read","Purchase orders"],
  ["online_orders.read","Online orders"],["online_orders.write","Submit online orders"],
  ["accounting.read","Accounting journals"]
];
export const INTEGRATION_EVENTS=["product.created","product.updated","inventory.changed","customer.created","customer.updated","sale.completed","sale.voided","return.completed","online_order.created","online_order.updated","sales_order.updated","purchase.received","integration.test"];
export async function integrationAdminRequest(session,action,payload={}){const response=await fetch("/.netlify/functions/integration-admin",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${session?.access_token||""}`},body:JSON.stringify({action,...payload})});const data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)throw new Error(data.error||`Integration request failed (${response.status})`);return data;}
export function downloadJson(filename,value){const blob=new Blob([JSON.stringify(value,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);}
export function integrationDate(value){if(!value)return "—";return new Intl.DateTimeFormat("en-US",{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));}
export function statusClass(status){return ["succeeded","active"].includes(status)?"success":["dead","failed","revoked"].includes(status)?"danger":["retry","pending","delivering"].includes(status)?"warning":"neutral";}
