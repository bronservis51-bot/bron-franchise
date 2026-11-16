// Only after strict final PASS. No database, capability, body or environment access.
Deno.serve(() => Response.json({ok:false,retired:true}, {
  status:410,headers:{"Cache-Control":"no-store"},
}));
