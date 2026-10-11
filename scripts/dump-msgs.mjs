let d = ""
process.stdin.on("data", (c) => (d += c))
process.stdin.on("end", () => {
  const j = JSON.parse(d)
  const msgs = j.data || []
  console.log("count", msgs.length)
  for (const m of msgs) {
    console.log(
      JSON.stringify({
        id: m.id,
        type: m.type,
        text: (m.text || "").slice(0, 150),
        content: (m.content || []).map((p) => ({
          type: p.type,
          text: (p.text || "").slice(0, 100),
        })),
        finish: m.finish,
        err: m.error && m.error.message,
      }),
    )
  }
})
