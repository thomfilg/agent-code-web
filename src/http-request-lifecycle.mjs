/** A completed early response must not leave an unfinished request body holding
 * its connection open. Do not touch the socket before response finish: handlers
 * reading/saving input and long-lived streaming responses are still active.
 */
export function closeIncompleteRequestAfterResponse(request, response) {
  const socket = request.socket;
  const cleanup = () => {
    response.removeListener("finish", finished);
    response.removeListener("close", cleanup);
  };
  const finished = () => {
    cleanup();
    if (!request.complete && !socket.destroyed) {
      // Flush pending socket output before closing this request's connection.
      // A next pipelined request cannot have been parsed while this request's
      // declared body is incomplete. Fully received inputs retain keepalive.
      socket.destroySoon();
    }
  };
  response.once("finish", finished);
  response.once("close", cleanup);
}
