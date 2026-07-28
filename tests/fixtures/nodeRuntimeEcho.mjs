process.on('message', (message) => {
  process.send?.({
    bytes: Buffer.from([1, 2, 3]),
    message,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE
  })
})

process.once('disconnect', () => process.exit(0))
