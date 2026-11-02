import hmac, hashlib
   computed = hmac.new(b"your_secret", request_body, hashlib.sha256).hexdigest()
   assert computed == headers["X-Aegis-Signature"]