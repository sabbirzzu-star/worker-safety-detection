// IISMS ESP32-S3-CAM edge node.
// Captures JPEG frames and POSTs them to the FastAPI /ingest endpoint.
// The backend performs inference; the dashboard displays its annotated stream.

#include "esp_camera.h"
#include <HTTPClient.h>
#include <WiFi.h>

// ---------- Set these values ----------
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL = "http://192.168.1.100:8000/ingest";
const uint32_t FRAME_PERIOD_MS = 400;  // 2.5 FPS
// --------------------------------------

// ESP32-S3-CAM pin map supplied for this project.
#define PWDN_GPIO_NUM -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 15
#define SIOD_GPIO_NUM 4
#define SIOC_GPIO_NUM 5
#define Y9_GPIO_NUM 16
#define Y8_GPIO_NUM 17
#define Y7_GPIO_NUM 18
#define Y6_GPIO_NUM 12
#define Y5_GPIO_NUM 10
#define Y4_GPIO_NUM 8
#define Y3_GPIO_NUM 9
#define Y2_GPIO_NUM 11
#define VSYNC_GPIO_NUM 6
#define HREF_GPIO_NUM 7
#define PCLK_GPIO_NUM 13

static bool connect_wifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting to Wi-Fi");
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 30000) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nWi-Fi connection timed out.");
    return false;
  }

  Serial.print("\nWi-Fi connected. ESP32 IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Backend endpoint: ");
  Serial.println(SERVER_URL);
  return true;
}

static bool init_camera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 10000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 14;
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    config.frame_size = FRAMESIZE_QVGA;
    config.jpeg_quality = 16;
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }

  const esp_err_t result = esp_camera_init(&config);
  if (result != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", result);
    return false;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  sensor->set_whitebal(sensor, 1);
  sensor->set_awb_gain(sensor, 1);
  sensor->set_exposure_ctrl(sensor, 1);
  sensor->set_gain_ctrl(sensor, 1);
  Serial.println("Camera initialized.");
  return true;
}

static bool post_frame(camera_fb_t* frame) {
  WiFiClient client;
  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(5000);

  if (!http.begin(client, SERVER_URL)) {
    Serial.println("Could not configure HTTP client.");
    return false;
  }

  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("Cache-Control", "no-cache");
  const int status = http.POST(frame->buf, frame->len);
  const bool accepted = status >= 200 && status < 300;

  if (accepted) {
    Serial.printf("Frame sent: %u bytes, HTTP %d\n", frame->len, status);
  } else {
    Serial.printf("Frame upload failed: HTTP %d\n", status);
  }

  http.end();
  return accepted;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\nIISMS ESP32-S3-CAM uploader starting...");

  if (!init_camera()) {
    Serial.println("Restarting after camera initialization failure.");
    delay(3000);
    ESP.restart();
  }

  while (!connect_wifi()) {
    delay(5000);
  }
}

void loop() {
  const uint32_t started = millis();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi lost; reconnecting.");
    WiFi.disconnect();
    while (!connect_wifi()) {
      delay(5000);
    }
  }

  camera_fb_t* frame = esp_camera_fb_get();
  if (frame == nullptr) {
    Serial.println("Camera capture failed.");
  } else {
    post_frame(frame);
    esp_camera_fb_return(frame);
  }

  const uint32_t elapsed = millis() - started;
  if (elapsed < FRAME_PERIOD_MS) {
    delay(FRAME_PERIOD_MS - elapsed);
  } else {
    delay(1);
  }
}
