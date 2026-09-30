package com.guardface.sentinel

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import java.util.Properties
import javax.activation.DataHandler
import javax.mail.Authenticator
import javax.mail.Message
import javax.mail.PasswordAuthentication
import javax.mail.Session
import javax.mail.Transport
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeBodyPart
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeMultipart
import javax.mail.util.ByteArrayDataSource

/**
 * Sends the intruder photo to the owner over Gmail SMTP (STARTTLS on port 587).
 * Requires a Gmail address + a 16-char App Password (not the normal login password).
 * Runs blocking — always call from a background thread.
 */
object MailSender {

    fun sendIntruderAlert(
        smtpUser: String,
        smtpPass: String,
        toEmail: String,
        photo: Bitmap,
        similarityPct: Int
    ) {
        val props = Properties().apply {
            put("mail.smtp.auth", "true")
            put("mail.smtp.starttls.enable", "true")
            put("mail.smtp.host", "smtp.gmail.com")
            put("mail.smtp.port", "587")
        }

        val session = Session.getInstance(props, object : Authenticator() {
            override fun getPasswordAuthentication() =
                PasswordAuthentication(smtpUser, smtpPass)
        })

        val message = MimeMessage(session).apply {
            setFrom(InternetAddress(smtpUser))
            setRecipients(Message.RecipientType.TO, InternetAddress.parse(toEmail))
            subject = "⚠️ GuardFace: unauthorized unlock attempt on your phone"
        }

        val textPart = MimeBodyPart().apply {
            setText(
                "GuardFace detected someone trying to unlock your phone.\n\n" +
                "Their face did NOT match yours (match score: $similarityPct%).\n" +
                "The phone has been locked. Attached is the photo taken at that moment.\n\n" +
                "— GuardFace"
            )
        }

        val out = ByteArrayOutputStream()
        photo.compress(Bitmap.CompressFormat.JPEG, 85, out)
        val imagePart = MimeBodyPart().apply {
            dataHandler = DataHandler(ByteArrayDataSource(out.toByteArray(), "image/jpeg"))
            fileName = "intruder.jpg"
        }

        message.setContent(MimeMultipart().apply {
            addBodyPart(textPart)
            addBodyPart(imagePart)
        })

        Transport.send(message)
    }
}
