# Sample Python verification script for Enterprise Webhook Receiver
   import hmac, hashlib

   def verify_aegis_signature(raw_body: bytes, received_sig: str, secret: str) -> bool:
       computed = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
       return hmac.compare_digest(computed, received_sig)