process.on('message', (message) => {
  process.send?.({
    bytes: Buffer.from([1, 2, 3]),
    execPath: process.execPath,
    message,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null
  })
})

process.once('disconnect', () => process.exit(0))
