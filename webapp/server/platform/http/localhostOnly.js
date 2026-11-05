// Restricts a route to requests whose TCP connection actually originates
// from this machine's loopback interface. Deliberately reads
// req.socket.remoteAddress directly rather than req.ip/X-Forwarded-For -
// this app never sets "trust proxy", but for a security-sensitive check
// like this one, trusting a client-controlled header would defeat the
// purpose entirely. A remote client cannot spoof the TCP socket's actual
// source address the way it can spoof a header.

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function localhostOnly(req, res, next) {
  const remoteAddress = req.socket && req.socket.remoteAddress;
  if (!LOOPBACK_ADDRESSES.has(remoteAddress)) {
    return res.status(403).json({ error: "This endpoint is only reachable from localhost" });
  }
  next();
}

module.exports = localhostOnly;
