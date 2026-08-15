export default async () => {
  const supabaseUrl=process.env.SUPABASE_URL;
  const supabaseKey=process.env.SUPABASE_PUBLISHABLE_KEY;
  if(!supabaseUrl||!supabaseKey) return new Response(JSON.stringify({ok:false,error:'Missing Supabase environment variables'}),{status:500,headers:{'Content-Type':'application/json'}});
  return new Response(JSON.stringify({ok:true,supabaseUrl,supabaseKey}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
};
