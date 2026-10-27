# Insurance Renewal — test and recording script

Number: the second Sarvam number
Check first: the deployment row shows the committed version

---

## A. Opening and identity

1. "Haan, bolo"
   Must ask whether it is Ambuj before quoting anything.

2. "Haan, Ambuj bol raha hoon"
   Must quote 20000. Not 15000. This is the single most important check.

3. "Main unka bhai hoon"
   No premium, no IDV. Asks for a good time. Ends politely.

## B. IDV

4. "IDV kam kyun ho gaya?"
   One line: car value drops yearly, 900000 to 800000.

5. "IDV 9 lakh hi rakho"
   Higher IDV means higher premium, offers to quote. No promised number.

6. "IDV ka matlab kya hai?"
   Maximum the insurer pays on theft or total loss.

## C. Price ladder

7. "20000 zyada hai"
   Now offers 15000, tied to confirming today.

8. "12000 mein kar do"
   Refuses. Never below 15000.

9. "Theek hai 20000 hi kar do"
   Accepts, and does not mention 15000.

10. "Pichhle saal kitna tha?"
    Says 20000 standard, 15000 is this year's discount.

## D. Competitor and online

11. "PolicyBazaar pe sasta mil raha hai"
    Online quotes look cheap because IDV is lower. Asks about claim follow-up.

12. "Acko ka quote 13000 hai"
    Does not match it. Compare same IDV and zero-dep.

13. "Online hi kar lunga"
    Mentions break-in and inspection after expiry. Does not argue.

## E. Add-ons

14. "Zero dep kya hai?"
    Plastic and fibre parts, bumper, headlight.

15. "Engine protect chahiye"
    Flood and water damage not covered by a standard policy.

16. "Iska extra kitna lagega?"
    Does NOT invent a price. Offers to send a quote.

## F. Dates

17. "Agle hafte renew karunga"
    Asks for the exact date. Does not convert it itself.

18. "Policy kab tak hai?"
    5 November.

19. "5 November ke baad kya hoga?"
    Break-in, inspection needed.

## G. Interruption and language

20. Interrupt mid-sentence: "Ruko, IDV pehle batao"
    Stops, answers, returns to the dropped point.

21. "I'll think about it" (English)
    Switches to English.

22. Back to Hindi mid-turn
    Switches back cleanly.

23. Stay silent 10 seconds
    Nudge at 8s, second at 11s, then hang up.

## H. Escalation

24. "Mera claim chal raha hai"
    Escalates, reads a four digit reference, stops selling.

25. "Manager se baat karni hai"
    Escalates, ticket, no invented name.

## I. Close

26. "Theek hai 15000, 30 October UPI"
    Reads back premium, date, mode. Asks about the payment link.

27. "Nahi chahiye"
    One line about lapse, then ends politely.

---

## Recording call (about 3.5 minutes)

1.  "Haan, Ambuj bol raha hoon."
2.  "IDV kam kyun ho gaya?"
3.  "20000 zyada hai, discount do."
4.  "PolicyBazaar pe sasta mil raha hai."
5.  "Aur kam karo, 12000 mein."
6.  "Zero depreciation kya hai?"
7.  Interrupt: "Ruko, engine protect bhi batao."
8.  "Iska extra kitna lagega?"
9.  "Agle hafte renew karunga."
10. "Theek hai, 15000, 30 October, UPI."
11. "Link bhej do."

---

## Pass criteria

Render logs:

    [tool] insurance_renewal log_commitment ACCEPTED 15000 on 2026-10-30
    [webhook] insurance_renewal ... score=

Sarvam, call detail, Overview:

    call_disposition      = renewal_agreed
    committed_amount      = 15000
    commitment_date       = 2026-10-30
    payment_mode          = upi
    primary_objection     = price_online_cheaper
    addon_pitched         = zero_dep
    compliance_flag       = none

Allowed numbers: 900000, 800000, 20000, 15000. Any other figure, including an
invented add-on price, is a fail.
