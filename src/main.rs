use actix_files as fs;
use actix_web::{web, App, HttpServer, HttpResponse, Responder};
use actix_web::middleware::Logger;
use serde::{Serialize, Deserialize};
use std::sync::Mutex;
use std::io::{Read, Write};
use std::fs::{OpenOptions, File};
use std::path::Path;
use std::thread;
use std::time::Duration;
use chrono::Local;
use serialport;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Debug)]
struct SensorData {
    voltage: f32,
}

#[derive(Serialize, Deserialize, Debug)]
struct ModelResult {
    actual_voltage: f32,
    predicted_voltage: f32,
    lamp_status: String,
    residual_error: f32,
    newton_raphson_steps: Vec<NewtonRaphsonStep>,
    iterations: i32,
    convergence_status: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct NewtonRaphsonStep {
    iteration: i32,
    x_current: f64,
    f_x: f64,
    f_prime_x: f64,
    x_next: f64,
    error: f64,
}

struct AppState {
    sensor_data: Mutex<SensorData>,
}

async fn get_sensor_data(data: web::Data<AppState>) -> impl Responder {
    let data = data.sensor_data.lock().unwrap();
    HttpResponse::Ok().json(&*data)
}

// Logika untuk mengontrol status lampu berdasarkan voltase
fn get_lamp_status(voltage: f32) -> &'static str {
    if voltage < 3.0 {
        "Lampu Menyala"  // Kondisi gelap (voltage < 3V)
    } else {
        "Lampu Mati"  // Kondisi terang (voltage >= 3V)
    }
}

// Model matematis untuk LDR dengan noise dan faktor koreksi
// V_actual = V_ideal + noise + drift
// Fungsi untuk mencari V_ideal: f(x) = x^3 - 2*x^2 + x - V_target = 0
// Model ini mensimulasikan hubungan non-linear antara intensitas cahaya dan tegangan
fn f_function(x: f64) -> f64 {
    x * x * x - 2.0 * x * x + x - 2.5 // Target ideal adalah 2.5V
}

// Turunan dari fungsi f(x): f'(x) = 3*x^2 - 4*x + 1
fn f_prime_function(x: f64) -> f64 {
    3.0 * x * x - 4.0 * x + 1.0
}

// Implementasi Newton-Raphson untuk prediksi tegangan LDR
fn newton_raphson_prediction(actual_voltage: f32) -> (f32, Vec<NewtonRaphsonStep>, i32, String) {
    // Model prediksi: V_predicted = V_base + correction_factor * (V_actual - V_reference)
    let v_actual = actual_voltage as f64;
    let v_reference = 3.0; // Tegangan referensi (threshold lampu)
    
    // Koefisien koreksi berdasarkan karakteristik LDR
    let correction_factor = 0.85; // Faktor koreksi untuk kompensasi non-linearitas
    let base_voltage = 2.7; // Tegangan dasar model
    
    // Generate pseudo-random noise berdasarkan waktu dan tegangan
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let noise_seed = (timestamp % 1000) as f64 / 1000.0; // Nilai 0-1
    let noise = 0.05 * (noise_seed * 6.28318).sin(); // ±0.05V noise
    
    // Implementasi Newton-Raphson untuk mencari akar persamaan karakteristik
    let mut x = 1.5; // Initial guess
    let tolerance = 1e-6;
    let max_iterations = 50;
    let mut steps = Vec::new();
    
    for i in 0..max_iterations {
        let f_x = f_function(x);
        let f_prime_x = f_prime_function(x);
        
        if f_prime_x.abs() < 1e-10 {
            let convergence_status = "Gagal: Turunan mendekati nol".to_string();
            let predicted_voltage = (base_voltage + correction_factor * (v_actual - v_reference) + noise) as f32;
            return (predicted_voltage, steps, i, convergence_status);
        }
        
        let x_next = x - f_x / f_prime_x;
        let error = (x_next - x).abs();
        
        steps.push(NewtonRaphsonStep {
            iteration: i + 1,
            x_current: x,
            f_x,
            f_prime_x,
            x_next,
            error,
        });
        
        if error < tolerance {
            // Hitung prediksi tegangan berdasarkan model dan hasil Newton-Raphson
            let characteristic_factor = x_next / 2.5; // Normalisasi hasil
            let non_linear_term = 0.08 * (v_actual - 2.0).sin(); // Faktor non-linear
            let aging_factor = 0.02 * (v_actual / 4.0).powi(2); // Faktor aging sensor
            
            let predicted_voltage = (base_voltage + 
                correction_factor * (v_actual - v_reference) * characteristic_factor +
                non_linear_term + aging_factor + noise
            ) as f32;
            
            let convergence_status = format!("Konvergen pada iterasi {}", i + 1);
            return (predicted_voltage, steps, i + 1, convergence_status);
        }
        
        x = x_next;
    }
    
    // Jika tidak konvergen, gunakan model linear dengan noise
    let predicted_voltage = (base_voltage + correction_factor * (v_actual - v_reference) + noise) as f32;
    let convergence_status = "Tidak konvergen - menggunakan model linear".to_string();
    (predicted_voltage, steps, max_iterations, convergence_status)
}

fn log_to_csv(actual: f32, predicted: f32, error: f32) {
    let path = Path::new("data_log.csv");
    let mut file = if path.exists() {
        OpenOptions::new().append(true).open(path).unwrap()
    } else {
        let mut file = File::create(path).unwrap();
        writeln!(file, "timestamp,actual_voltage,predicted_voltage,residual_error").unwrap();
        file
    };

    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let line = format!("{},{:.3},{:.3},{:.6}\n", timestamp, actual, predicted, error);

    if let Err(e) = file.write_all(line.as_bytes()) {
        eprintln!("⚠ Gagal menulis ke CSV: {}", e);
    }
}

fn start_serial_reader(app_state: web::Data<AppState>) {
    thread::spawn(move || {
        let port_name = "COM8";
        let baud_rate = 9600;

        let mut port = match serialport::new(port_name, baud_rate)
            .timeout(Duration::from_secs(1))
            .open() {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("❌ Gagal membuka port serial: {}", e);
                    return;
                }
            };

        let mut buffer: Vec<u8> = vec![0; 32];

        loop {
            match port.read(&mut buffer) {
                Ok(n) => {
                    let input = String::from_utf8_lossy(&buffer[..n]).to_string();
                    if let Ok(voltage) = input.trim().parse::<f32>() {
                        let mut data = app_state.sensor_data.lock().unwrap();
                        data.voltage = voltage;
                        
                        // Hitung prediksi dan error
                        let (predicted, _, _, _) = newton_raphson_prediction(voltage);
                        let error = (voltage - predicted).abs();
                        
                        log_to_csv(voltage, predicted, error);
                    } else {
                        eprintln!("⚠ Gagal parsing nilai: '{}'", input.trim());
                    }
                }
                Err(_) => {}
            }

            thread::sleep(Duration::from_millis(500));
        }
    });
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();

    let sensor_data = SensorData { voltage: 0.0 };
    let app_state = web::Data::new(AppState {
        sensor_data: Mutex::new(sensor_data),
    });

    start_serial_reader(app_state.clone());

    HttpServer::new(move || {
        App::new()
            .app_data(app_state.clone())
            .wrap(Logger::default())
            .route("/api/sensor", web::get().to(get_sensor_data))
            .route("/api/perhitungan", web::get().to(get_model_result))
            .service(fs::Files::new("/", "./front").index_file("index.html"))
    })
    .bind("127.0.0.1:8084")?
    .run()
    .await
}

// Fungsi untuk mengembalikan hasil model termasuk perhitungan Newton-Raphson lengkap
async fn get_model_result(data: web::Data<AppState>) -> impl Responder {
    let data = data.sensor_data.lock().unwrap();
    let actual_voltage = data.voltage;

    // Hitung prediksi menggunakan Newton-Raphson
    let (predicted_voltage, steps, iterations, convergence_status) = 
        newton_raphson_prediction(actual_voltage);

    // Hitung residual error
    let residual_error = (actual_voltage - predicted_voltage).abs();

    // Menggunakan fungsi get_lamp_status untuk mendapatkan status lampu
    let lamp_status = get_lamp_status(actual_voltage);

    let result = ModelResult {
        actual_voltage,
        predicted_voltage,
        lamp_status: lamp_status.to_string(),
        residual_error,
        newton_raphson_steps: steps,
        iterations,
        convergence_status,
    };

    HttpResponse::Ok().json(result)
}