import { createServer } from 'node:net'

/**
 * Reserve and release an ephemeral TCP port, returning the port number.
 * Tests can use this to reduce port collision flakiness when spawning daemons.
 */
export async function getAvailablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Failed to resolve an available TCP port'))
        })
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}
