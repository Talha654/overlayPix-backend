import QRCode from 'qrcode';
import { bucket } from './firebase.service.js';

export const generateEventQRCode = async (eventId, eventName) => {
  try {
    const url = `https://yourapp.com/event/${eventId}`;
    const qrDataURL = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    
    // Convert to buffer
    const base64Data = qrDataURL.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Upload to Firebase Storage
    const fileName = `qrcodes/${eventId}-${Date.now()}.png`;
    const file = bucket.file(fileName);
    
    await file.save(buffer, {
      metadata: {
        contentType: 'image/png',
        metadata: {
          eventId,
          eventName
        }
      },
      public: true
    });
    
    return file.publicUrl();
  } catch (error) {
    console.error('QR Generation Error:', error);
    throw new Error('Failed to generate QR code');
  }
};