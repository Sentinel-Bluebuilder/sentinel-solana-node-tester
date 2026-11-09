# ─── Bandwidth lab adversary: a fake speed origin on the LAB NODE VM only ───
# Answers every HTTPS request with fast zeros under its own self-signed key, as a node that
# intercepts the tester's speed test would. Started by adversary/mitm.sh, never anywhere else.
import http.server, ssl, sys

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a):
        pass
    def do_GET(self):
        if self.path.startswith('/p'):
            self.send_response(204); self.send_header('Content-Length', '0'); self.end_headers(); return
        n = 200_000_000
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(n))
        self.end_headers()
        z = b'\0' * 65536
        try:
            while n > 0:
                k = min(n, len(z)); self.wfile.write(z[:k]); n -= k
        except (BrokenPipeError, ConnectionResetError) as e:
            sys.stderr.write(f'client went away: {e}\n')

srv = http.server.ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1])), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(sys.argv[2], sys.argv[3])
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
