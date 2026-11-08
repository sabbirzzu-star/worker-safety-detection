// IISMS edge node: ESP32-CAM (AI-Thinker) posts a VGA JPEG every ~400 ms to the FastAPI server.
// Board: "AI Thinker ESP32-CAM" | Partition: "Huge APP" | PSRAM: Enabled
#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>

// ===== EDIT THESE =====
const char* WIFI_SSID   = "YOUR_WIFI_OR_HOTSPOT";
const char* WIFI_PASS   = "YOUR_PASSWORD";
const char* SERVER_URL  = "http://192.168.1.100:8000/ingest";  // PC running the backend
const uint32_t PERIOD_MS = 400;                                  // 2.5 FPS
// ======================

// AI-Thinker pin map
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

static void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);              // lower latency, steadier throughput
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("WiFi");
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(300); Serial.print(".");
    if (millis() - t0 > 20000) { Serial.println("\nretry"); WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS); t0 = millis(); }
  }
  Serial.printf("\nconnected, IP %s\n", WiFi.localIP().toString().c_str());
}

static bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM; c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM; c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_VGA;        // 640x480
  c.jpeg_quality = 12;                 // 10 = best, 63 = worst
  c.fb_count = 2;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;    // never send a stale buffered frame
  if (esp_camera_init(&c) != ESP_OK) return false;
  sensor_t* s = esp_camera_sensor_get();
  s->set_whitebal(s, 1); s->set_awb_gain(s, 1); s->set_exposure_ctrl(s, 1); s->set_gain_ctrl(s, 1);
  return true;
}

void setup() {
  Serial.begin(115200);
  if (!initCamera()) { Serial.println("camera init failed, rebooting"); delay(2000); ESP.restart(); }
  connectWifi();
}

void loop() {
  uint32_t t0 = millis();
  if (WiFi.status() != WL_CONNECTED) connectWifi();

  camera_fb_t* fb = esp_camera_fb_get();
  if (fb) {
    HTTPClient http;
    http.setTimeout(2000);
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "image/jpeg");
    int code = http.POST(fb->buf, fb->len);
    if (code != 200) Serial.printf("POST failed: %d\n", code);
    http.end();
    esp_camera_fb_return(fb);
  }
  uint32_t used = millis() - t0;
  delay(used < PERIOD_MS ? PERIOD_MS - used : 1);   // non-blocking cadence, caps heat + Wi-Fi load
}
