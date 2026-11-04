package dev.girru.app.crypto

import java.security.KeyFactory
import java.security.KeyPair
import java.security.PrivateKey
import java.security.spec.PKCS8EncodedKeySpec

/**
 * Byte-exact vectors made by the computer's reference TypeScript
 * (packages/backend/src/phone/protocol/pairing.ts and e2e.ts) with throwaway
 * test keys. Regenerate them from that code when the protocol changes; never
 * edit a value by hand.
 *
 * Made with: computer = createIdentity(), phone = createIdentity(), other = createIdentity();
 * pairing id "p_" + 32×0x07, secret 32×0x09; sealChallenge(computer, pid, secret, phone.id);
 * checkCode(secret, ck, phone key, challenge); sealWelcome(..., notifyKey 0x01..0x20,
 * lifetimeDays 60, name "Desk") and with lifetimeDays null; startHandshake(phone, computer.id, TS),
 * answerHandshake(computer, phone key, hs1, TS + 50), then one seal per direction;
 * sealNotice(computer, phone.id, notifyKey, 7, approval, TS); signCommand(phone, computer.id, 5, DECIDE_BODY, TS).
 */
object ReferenceVectors {
    const val COMPUTER_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgMx1ji85Gi7Bpar7gecG75zJoYSfzjtD12XAt9MaxMmShRANCAARlEtqkjLse9TCyyT7ZZdAAfJ7woXQFsqPpww-BXP5r9AHHm6bSwY57jkQIrGSxmrSyGUfS1QVfHD5JMu1E5TVq"
    const val COMPUTER_SPKI = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZRLapIy7HvUwssk-2WXQAHye8KF0BbKj6cMPgVz-a_QBx5um0sGOe45ECKxksZq0shlH0tUFXxw-STLtROU1ag"
    const val COMPUTER_ID = "Bzw_XPuk8uzJUjKqsYMgrbmlX-RIwXY9SV9339RGb1c"
    const val PHONE_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgEDikGgML-P7hYVCGGKnYUMeoSzRLJeSH4Yr6XpWpTYKhRANCAAQSlzkk3VoHxnAOat1B1ebVN5DDHz489mL1Pvg-z51LqPKdHDOoz8GQ02JO4dodFhEhLyyZrs3nCHbBWyLiaSx5"
    const val PHONE_SPKI = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEEpc5JN1aB8ZwDmrdQdXm1TeQwx8-PPZi9T74Ps-dS6jynRwzqM_BkNNiTuHaHRYRIS8sma7N5wh2wVsi4mkseQ"
    const val PHONE_ID = "Ah6aybUog6dw6QnCtu3nQsknlsZu98fHpUtU7XODZIk"
    const val OTHER_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgbDRNrvVnaMFhSKHn767MVxYfScZavk0N4mi1elFCxu-hRANCAASDtCjVhdJx1XrTLjgEqeAaVnX20sa2VYNwUKIvLYRPA3pWXeNEIr2jm1q6Ey9g32qUNQOjBcOitW7EmZuvObHe"
    const val OTHER_SPKI = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEg7Qo1YXScdV60y44BKngGlZ19tLGtlWDcFCiLy2ETwN6Vl3jRCK9o5tauhMvYN9qlDUDowXDorVuxJmbrzmx3g"
    const val OTHER_ID = "2h9VWDFBdjssrtVjj-Ix-A8kHmyhC1Cf8-XeNvfFSnI"
    const val PAIRING_ID = "p_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
    const val SECRET = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"
    const val PAIRING_KEY_HEX = "9d9d59d137e133e00032a93b73921078fed2cd4be3a0d1f47a73f7b3a0a97720"
    const val PCHAL = "g1.pchal.-Uk08ZyjIYgEPt0g6rAqI9_6afLjOcGhiQi3XfxC9-NiDdPTjxM4Td9SkFtFRRVS0M1n_EtjqgUZ8umIAIO5CRnm0sLuWqD_nhu8xVryKWLqX9C6T3_4ZuEVrBcLtLvlGe71i4_7s_nYYGIwM6vYO-N9WXlLBFyWoA0zcRoPyh3Tm_A9B35n6cmZ2LgevJ5ensih5jGbzyM8_oaS9Xc4QmjS_KLR2QW0y2HxhVArBdiR7GGKyygSFIoAgPjtGILIwUVtf7ek.MEQCIHXt2ZZuiW38Uls91Bu3gKOKXmlGl7CqyxAJj-sMA78DAiA7BtrYnYNS9EOQ1NBuD13413tExnm2odG67SRbRIbfyA"
    const val PCHAL_FOR_OTHER_PHONE = "g1.pchal.WDcst16PLdamx44q5W3BxXY3oCX2vqXBvbHPW3Kyyqhr3-_nM3F1HZxAS8BdFLXMilzJMN9nl5WE5fwn2giX3gRwme5Emp4PEHFdf8NQxf7ke4cSHpaPo46bokvOeIYQxFAskSuXyK0UlZQHhmATcuWuQtqJ1TNx2OlgePSBXY4Gyxlg02K7U_peiODd_xf4l9PaEZeWBM7Rc1nll5gmXRH0cOcm8cSXGqd7NWUbCoCjjOsCPnvRn1YdJ_Jg1X97jbVap3E2.MEYCIQDB3m8WiJYc5XUX8umvXyKEuwk51K7m-lJiqe1NrUdfzAIhANuSFQe8Mf-JNZipyXjTlkRN-OixaP7cXa8kqjXrrcIu"
    const val CHALLENGE = "yAcgRYZp_EHLoGvyEMV01S4In4qnto9XfjN9fk_YMCE"
    const val CHECK_CODE = "279095"
    const val CHECK_DIGEST_HEX = "deff63777effeff7cfe1fb4b39049d2e53378e461e72f82ff2d6d3524d57b353"
    const val PWEL = "g1.pwel.sSqGLCJ3VtVWZpHC66D6KwAU5fmg1JXxcT4UpOHGVreE1EF8stGVxHh0m-OormabjbPPT9xKRHsOKeIXTPjd0zUf-4ttVJ1-ZBdw-L0LDH2UM4gbnM3hv4iS8n6M6kjMDbZfvsm4zkdNTLdpgWPt7quXTRKqCuQjLpWtISloIZvyjRQjufa_spz5B_ilKmNJRq1VkUaSsN2qrO1mrqAHpRvwk9qCn1npFfsQaQ-LN8Q0v6Yu2vp8fB05yQ0VMhCWUo649zGpjJiqyLIpdlEaK2m_ZwabOwI1n2ZmnFJ2pM4iZIwfjM9fC0uIDaJk96phDYSkMlS7hdLUEiRqJPdAFWKfd2pN8ADxSykf.MEUCIQCspr6hWI7aTPKIGIjVx8yaubVaaUgR2wY1qWdt2FiCBwIgY3_BJNzes6Yb7CoagGv_1V6wYYaDY3_NP3BQEw_sfQ8"
    const val PWEL_NEVER = "g1.pwel.51MnBo-BZuDxq-fomgDZaTwCzYTfvM05DTQaS9I4dtdzEtEdT-mPrYfYF8xyIrpzG8SMf4Z0bhkviUgTzf5l3pn81KxkaiZG9C7NLskpyXisVYl97-DTqeG1EsO7Lc3c1XphwdAoGMEPK_h5v0DrYfSZJ-rD2VlZPOWAJdmT8rClWeH9po2VtejErq2VrvpzwmrCajekbc6f0FkDG72Ay67r4ciMdp7M3StEt3NAnRDXUeYCrLRsRjoIulH0e61E_OrVPUMZfMOlnb2ocMStV4ADK2a0sKSDxfvc2Iwvo3oJBRrY4XCR9iejFw.MEUCIQDQASDjvqJvGb4YVlhbfCJ6gSsRFn3y70J9Mi7FlNlPeAIgajOW1QqPwCPexfDKo-nUOcGenGpFW1f0qQiPcQlS170"
    const val NOTIFY_KEY = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"
    const val NKEY_SHARED_HEX = "92d772b9c2dd29c4e89c43929040a25bf1838e31cf26bbd09ad4d942170a4d26"
    const val NKEY_WRAP_HEX = "625e02681582e72507896c9899d9cf2d2cd3e335be078502864031dd4a0b6e1e"
    const val TS = 1800000000000L
    const val HS1 = "g1.hs1.eyJmcm9tIjoiQWg2YXliVW9nNmR3NlFuQ3R1M25Rc2tubHNadTk4ZkhwVXRVN1hPRFpJayIsInRvIjoiQnp3X1hQdWs4dXpKVWpLcXNZTWdyYm1sWC1SSXdYWTlTVjkzMzlSR2IxYyIsImVwaCI6Ik1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRU9QVzNKWEI1TmNpTDFLUWd6MkVYX1l5WWdFZTZRLTZ6YVRoMnFPYXpGUWkxcDhDTjRRbzladGRJRVJWRFl3UVVybklPbkF0STJHcXNDM3ppamVGZVh3IiwidHMiOjE4MDAwMDAwMDAwMDAsIm5vbmNlIjoiUklacmpRRmRFZS0xZi1WWm5QMC1sQSJ9.MEYCIQDevc-4vwxrZifgCm0XO_zlcCrQjwiC3wDpRQt7zdZFqgIhAMX8V5FkMgdc09-ETnQFE6nJoW8qS3Urs1ieGyIMzFPY"
    const val HS2 = "g1.hs2.eyJmcm9tIjoiQnp3X1hQdWs4dXpKVWpLcXNZTWdyYm1sWC1SSXdYWTlTVjkzMzlSR2IxYyIsInRvIjoiQWg2YXliVW9nNmR3NlFuQ3R1M25Rc2tubHNadTk4ZkhwVXRVN1hPRFpJayIsImVwaCI6Ik1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRUNnWkxJTXM5d0pWblgyR3RFRXNPbXp2TFN1LTFPUHBjUGVHSmZXOWZwc3BaV2FEOGFUWEJ5MkZUTWNtbXc3Yko5aFRtU3pRTU5TYlg2NXBEbzE1RHR3IiwidHMiOjE4MDAwMDAwMDAwNTAsImgxIjoiZU5keWFLN0RZcFdLMHVsMkNfXzI1M2NneDdydWk3X2ZlbVY5N19ZZDc1RSJ9.MEQCIGl0jQXYHaK8Gx9suZPw6-bQaAdT2WyQc11N2ro2U7PWAiBSExvBkcuM_3Z3bmpLhEPE_AMmxcK1TjqXEKBXsSPCfg"
    const val EPH_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg6RwPxG-MikymCRecLow5FrCY9hn1d9VsG6-tcvbfyGShRANCAAQ49bclcHk1yIvUpCDPYRf9jJiAR7pD7rNpOHao5rMVCLWnwI3hCj1m10gRFUNjBBSucg6cC0jYaqwLfOKN4V5f"
    const val EPH_SPKI = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEOPW3JXB5NciL1KQgz2EX_YyYgEe6Q-6zaTh2qOazFQi1p8CN4Qo9ZtdIERVDYwQUrnIOnAtI2GqsC3zijeFeXw"
    const val SESSION_ID = "1HgBuFyLRt9OEdr5JAA5LQ"
    const val MSG_FROM_COMPUTER = "g1.msg.eyJzaWQiOiIxSGdCdUZ5TFJ0OU9FZHI1SkFBNUxRIiwic2VxIjoxLCJmcm9tIjoiQnp3X1hQdWs4dXpKVWpLcXNZTWdyYm1sWC1SSXdYWTlTVjkzMzlSR2IxYyIsInRvIjoiQWg2YXliVW9nNmR3NlFuQ3R1M25Rc2tubHNadTk4ZkhwVXRVN1hPRFpJayJ9.ewL5ipheBOVeb5H8O93xRaZfJjbb6hNqkKic2dIiWbtSnZdRz7Sa2hCpcSj4UG1oaaQVWPWMYaff0E-RMmWzMzb6Fk_qEOwZAMSXgKhVV_xdxUgEhy3HPoGpFt5XKTjKQJg8cFU"
    const val MSG_FROM_PHONE = "g1.msg.eyJzaWQiOiIxSGdCdUZ5TFJ0OU9FZHI1SkFBNUxRIiwic2VxIjoxLCJmcm9tIjoiQWg2YXliVW9nNmR3NlFuQ3R1M25Rc2tubHNadTk4ZkhwVXRVN1hPRFpJayIsInRvIjoiQnp3X1hQdWs4dXpKVWpLcXNZTWdyYm1sWC1SSXdYWTlTVjkzMzlSR2IxYyJ9.PHlhYKgdGu6LBrqp7_l49Z9BDrgLUQEe0AHTh-9G"
    const val NTF = "g1.ntf.eyJmcm9tIjoiQnp3X1hQdWs4dXpKVWpLcXNZTWdyYm1sWC1SSXdYWTlTVjkzMzlSR2IxYyIsInRvIjoiQWg2YXliVW9nNmR3NlFuQ3R1M25Rc2tubHNadTk4ZkhwVXRVN1hPRFpJayIsImN0ciI6NywidHMiOjE4MDAwMDAwMDAwMDAsImJveCI6Ik9rWjhETXVjLU5fV0JWemZwNlhFX0M4dlhWUGdOcHBPYTdlNXlmSU5lMDVlZVg5cjhEQzJqd045V0paT3pRcTVvOWZsX19mRVRHdU5CTlF4cEx0eEZIc3B0SVRUN295NnpOMHlpRXRDVUZkTUpNU000aTVoR2NudlhyWVIweXRibV9EQ2d2NFcwaTV2M1R6VDVVWDlaQVZfUUF4cXF1SVJYTlRkLWI1QVpuaTR0RzVsQm92V3ZTU1VaUSJ9.MEQCIGSH9dfPTZCmfpjZ5CxAXg3TalXdvx3cgVShwJDUOw0JAiAuwksJ1ZtpAGGEfxJ6rgFzMcv4SPI8pNKC0o9XopFPNA"
    const val DECIDE_BODY = "{\"approve\":true,\"id\":\"0b6c4c1e-3a7e-4c1b-9d0e-2f1a3b4c5d6e\",\"paramsHash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"type\":\"approval.decide\"}"
    const val CMD_NONCE = "7GtKvT8-JWm545g0sy8_qw"
    const val CMD_CTR = 5L
    const val CMD_SIG = "MEUCIFHEY2riHAgEmlKHzIEjUzc2KnVdjWLybflzAS6k5krdAiEAz6WpjEISDdNwkwbB9wSI2JjuQcfY1_fe3tYWx2ENLW8"

    const val APPROVAL_ID = "0b6c4c1e-3a7e-4c1b-9d0e-2f1a3b4c5d6e"
    const val COMPUTER_MESSAGE = "{\"type\":\"run.end\",\"ref\":\"r1\",\"runId\":\"phone-1\",\"status\":\"dropped\",\"code\":\"slow_link\"}"
    const val PHONE_MESSAGE = "hello computer"

    fun bytes(b64url: String): ByteArray = G1.fromB64url(b64url) ?: error("bad vector")

    fun privateKey(pkcs8: String): PrivateKey = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(bytes(pkcs8)))

    fun keyPair(spki: String, pkcs8: String): KeyPair = KeyPair(G1.p256PublicKey(bytes(spki))!!, privateKey(pkcs8))

    /** Software ECDH standing in for the Keystore key. */
    fun agreer(pkcs8: String): KeyAgreer {
        val key = privateKey(pkcs8)
        return KeyAgreer { peer -> G1.ecdh(key, peer) ?: throw G1Exception("bad_key") }
    }

    fun signer(pkcs8: String): Signer {
        val key = privateKey(pkcs8)
        return Signer { data ->
            java.security.Signature.getInstance("SHA256withECDSA").run {
                initSign(key)
                update(data)
                sign()
            }
        }
    }
}
