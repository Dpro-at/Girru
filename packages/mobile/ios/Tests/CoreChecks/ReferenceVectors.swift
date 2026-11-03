// Generated once from the computer's reference code
// (packages/backend/src/phone/protocol/pairing.ts, run with Node at
// now = 1 800 000 000 000 ms). Test keys only; they protect nothing.
// Regenerate when the reference changes, never edit by hand.

enum ReferenceVectors {
    /// computer private scalar (JWK d)
    static let computerD = "-bAM_B0SeakDePgs_7J0KiMB4QnvusrgYpK4SsagZDk"
    /// phone private scalar (JWK d)
    static let phoneD = "GEItSyQCnFd-YALxnNI15twzkeK7SUr97KnYJ17sqSc"
    /// a third phone
    static let otherD = "9Av_V_3aYvvrqDkw71nJoxLGgzDCiGy488psu3hlc08"
    /// qrText, exp = now + 2 minutes
    static let qr = "girru://pair?v=1&cid=CLE54K3da9fDAJDh2IUtxtdlmeLZ676ujEEOyqypeVg&ck=MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEwSlLoajDa9xXyRHJUni2la2shfvVSp6-boQS-ZZUEv2dFzWMosnSr6IFU4yBAs-Jcj3LHm_mtutm6ZCuXZy7KQ&pid=p_pyFpJN-uLfxCaBY3K6-tRhR3DE-q35D60dCAJoHHO_A&ps=1GOFYuAzOSx7KezBHzRTr7YXlE6NPkRe9bWWPZy_7fA&exp=1800000120&relay=wss%3A%2F%2Frelay.example.org%2Fv1&name=Office+Mac"
    static let pid = "p_pyFpJN-uLfxCaBY3K6-tRhR3DE-q35D60dCAJoHHO_A"
    static let secret = "1GOFYuAzOSx7KezBHzRTr7YXlE6NPkRe9bWWPZy_7fA"
    /// sealPairingRequest by the phone (lifetimeDays 60)
    static let preq = "g1.preq.B0ZZeQkn2FGnF29Y.YB0SYSNfZx68uaJt9BImZtGdCQOtltzlpXHSCoELXcQkKvZO4FdKm7ca6rk0jfr-xYNiNdwtGiJM5i2e5OsYj6MiiWxaOVcflI3XUbcke26W1mo9tGuoxTjANdNPwmuiqUVM0Y66zm7lRZFUTMkFjzt-xZ4uEeQWWS7Uvf-cEspmtYDv8kLg1U1PzH7wazjUPmeDlSItyzJeAO4x8ehFe4CZO-t3YlQtmR2Ln1qbn36Kn2l1GXaq5O8IjYQCCni7tz7ZADRq9GOxQ9VyMRo_kqvaZ8tKWrOvFyl3icUibafGhZrchfedpCtX5fJ9p_TbxmmQz9zI7UfNQZffgXGPOb_2EEb_CcEP0qL7_6g1ihk7kKgpl_vGWxqN0YxSDn7mERj6myHeZeT-qkeLLOJsXwJyHM5J"
    /// sealChallenge for the phone
    static let pchal = "g1.pchal.-woVoCsl-ad1_JXxer-Gg5zmhgjM-bN1eVLxdBgcYhND_ArQ1cpw_oVAmO8Ezm1dkQnROvSagWrIMlzZcrUYYyKf5uO58hp6WLuUo4lSuMRuZHsSVcIwoYfYTZjcR38mkJ968-pnhDbaZYey9FmEy54YFhVYcKiBSEoINrUTnirJ5vSsUE7-N-n7wm8_KeQsosD5zzoSGi3BkPl1I5DcI6dNE7fuPABywyi9YpgU4Q4HjbKwyMXl5CKTcsi30f1pYPYvQgEp.MEYCIQDtTQisRLmzP9wDcRinFqBB1b0Utf9Ph2zlR8WJ9SeicwIhAO4WkUuxUshOfBMk1NIdV-UpUkshJmTslXCCqMF_MVgr"
    /// its raw challenge
    static let challenge = "wfPLgcamVqWVzQQSFGPy5nFiecNFwjvYkqlKrViA_ug"
    /// checkCode for that challenge
    static let code = "513566"
    /// sealWelcome (lifetimeDays 60, name "Office Mac")
    static let pwel = "g1.pwel.MUjEbA_G00eAYf5tX5kbaq3Rxa02SNIHBKdOCjGuYNYCfPIXrI8dyntsBLnz2N9cVlNeTrRAnVJNN9KVbqerhJPplSPpYYJLQGtFbUEQXUw0eYNjXQiWbxUcoin7ey18CDOadRN-ev6PKx2R8efV5ENJ-rnv3dQIPK87N_qhx9K0CQ1uC5t_cJCdyT68ibqTJL_1ZK41BmkhcqK23GcLsRjZENPddwwBxcmDBPQ0VcQf7lYYxPnZQpLAFQ9Kp4qn6K2aqFkIQ9h4Sn4hXVDH_8l4NBeOfpAWBpHFROYAQoLW_bXhRx2Si1CfNeDwUN0NGNBXaC6e5RSDUdecGyB36t-QWjkbk40N6ZPxcla0TDTg.MEQCIDMnvikEA6rJjurOUlXoNI5sZ-A-u5Hz4igMsejGuSQeAiA7bnWkkz1EEicNg1y0ASVDrnEQs4zI0IAds2JE_MLpRQ"
    /// sealWelcome (lifetimeDays null)
    static let pwelNever = "g1.pwel.iVisM4zPK11dPvryaNanQbXbFd0J7pivBvmyTNFccSxvN-Ui_0APOTLQPaico7jYHE2VsgAQ1etrZn0Qx0JjO-vFaHW90ubj3PObGdXliqaCe0RaiNoNbBIf47gae096DlJXXFVNks0XSPHVvhjscg2uN9Gr-M1jEDt-pSeNYFY7K55gaDboN_bnYQSeVaFRJmaA5b_BTjGYNgNYc4KxWkwvNDh4Eo-qlGzOxSMp_2vEeqBJU5RLPWaocB6Cau0kbk1tXNANdVRkSK3SJ7EilOvWSUv9qin9JKN6KMD1lAOnuXJysurlNd_wSQ.MEUCIQDGV-G3E8EQdj0vOX9UZGRrOUxUwXuGceg3dAJHMhmhUAIgBClhAKiRB5g0LM9YSZ5uIfHaFcsk2gioAt8HnH508Wg"
    /// the raw notification key in both welcomes
    static let notifyKey = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw"
    /// sealChallenge addressed to the third phone
    static let pchalOther = "g1.pchal.SzeXUG9zJ8iR_76z1h7ZL5VsQJ9j-UcEgHCyIPkF7eQLwTr_07rnHcm71mElw9APrLh780Jnhi2xbjBEavzFXUTA3p0aJdIRMLTBDGujOYyjy4DYqfC4Vu7WE1wkaqsXEiiA6nhKzGzcIIbpxCsDrU26LsmlKYQdit4m9pHigJAAUIXQNi-P3q2N6F6btQ6LMVWjhIdWqBqUzaM9fZ84Zx5LXhxYogfRqxyO1fH0_n5XcsDrYgQCrp1k_D1ubyYehmZ-X4dK.MEQCIBkB2k_rBwbDMEPXOexh8NFbUOuUgXI2wEHGw67SK7rwAiBUSI8-kvOKJ4_TNOyLAbgPNJ23wjUpNb5ZQbSFsKr0Qw"
    /// sealNotice ctr 5 under notifyKey
    static let ntf = "g1.ntf.eyJmcm9tIjoiQ0xFNTRLM2RhOWZEQUpEaDJJVXR4dGRsbWVMWjY3NnVqRUVPeXF5cGVWZyIsInRvIjoiaUtRblNQVWh3ODRmUnJNaXdNRUNQUjN6bmJRcktUcG8tLVlhQTVEQTFSSSIsImN0ciI6NSwidHMiOjE4MDAwMDAwMDAwMDAsImJveCI6Ik8wTDZMY1N5bm1sTTM5YkFYX2NMOXQ3eWwyTkxUVW5rZUZTNDhweHh4eGoybWFvaFVSRlNWMEplS3BDc21YcV81RjdDQ0F2T1JlaWE3MDRZTVgxcTluLUZzQ08xS2RENXA0TG9raHNMeWFSaks1WUhmRFJSbEhkVWRBak9JZVdSbHAyc1hack1xY3lZIn0.MEQCIBF87QAHobifs9FSChKcwMHESypnUF0N18xttu-irZBUAiAC79cSfb_hQf5Zu8yUifWsgbEVAmHif_WdHRYLWNCIVw"
    /// checkCode(secret 32 x 0x01, these keys, challenge 32 x 0xaa)
    static let fixedCode = "844341"
}
