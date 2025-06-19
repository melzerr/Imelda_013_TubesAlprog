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
    humidity: f32,
    temperature: f32,
}

#[derive(Serialize, Deserialize, Debug)]
struct ModelResult {
    actual_humidity: f32,
    predicted_humidity: f32,
    humidity_status: String,
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

// Fungsi untuk menentukan status kondisi berdasarkan humidity
fn get_humidity_status(humidity: f32) -> &'static str {
    if humidity < 30.0 {
        "Sangat Kering"
    } else if humidity < 40.0 {
        "Kering"
    } else if humidity < 60.0 {
        "Normal"
    } else if humidity < 70.0 {
        "Lembab"
    } else {
        "Sangat Lembab"
    }
}

// Model matematis untuk sensor humidity dengan noise dan faktor koreksi
fn f_function(x: f64) -> f64 {
    x * x * x - 2.0 * x * x + x - 50.0
}

// Turunan dari fungsi f(x): f'(x) = 3*x^2 - 4*x + 1
fn f_prime_function(x: f64) -> f64 {
    3.0 * x * x - 4.0 * x + 1.0
}

// Implementasi Newton-Raphson untuk prediksi humidity
fn newton_raphson_prediction(actual_humidity: f32) -> (f32, Vec<NewtonRaphsonStep>, i32, String) {
    let h_actual = actual_humidity as f64;
    let h_reference = 60.0;
    
    let correction_factor = 0.85;
    let base_humidity = 45.0;
    
    // Generate pseudo-random noise berdasarkan waktu dan humidity
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let noise_seed = (timestamp % 1000) as f64 / 1000.0;
    let noise = 2.0 * (noise_seed * 6.28318).sin();
    
    // Implementasi Newton-Raphson
    let mut x = 1.5;
    let tolerance = 1e-6;
    let max_iterations = 50;
    let mut steps = Vec::new();
    
    for i in 0..max_iterations {
        let f_x = f_function(x);
        let f_prime_x = f_prime_function(x);
        
        if f_prime_x.abs() < 1e-10 {
            let convergence_status = "Gagal: Turunan mendekati nol".to_string();
            let predicted_humidity = (base_humidity + correction_factor * (h_actual - h_reference) + noise) as f32;
            return (predicted_humidity, steps, i, convergence_status);
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
            let characteristic_factor = x_next / 50.0;
            let non_linear_term = 3.0 * (h_actual / 100.0 - 0.5).sin();
            let aging_factor = 0.5 * (h_actual / 100.0).powi(2);
            
            let predicted_humidity = (base_humidity + 
                correction_factor * (h_actual - h_reference) * characteristic_factor +
                non_linear_term + aging_factor + noise
            ) as f32;
            
            let convergence_status = format!("Konvergen pada iterasi {}", i + 1);
            return (predicted_humidity, steps, i + 1, convergence_status);
        }
        
        x = x_next;
    }
    
    let predicted_humidity = (base_humidity + correction_factor * (h_actual - h_reference) + noise) as f32;
    let convergence_status = "Tidak konvergen - menggunakan model linear".to_string();
    (predicted_humidity, steps, max_iterations, convergence_status)
}

fn log_to_csv(actual: f32, predicted: f32, error: f32, temperature: f32) {
    let path = Path::new("humidity_data_log.csv");
    let mut file = if path.exists() {
        OpenOptions::new().append(true).open(path).unwrap()
    } else {
        let mut file = File::create(path).unwrap();
        writeln!(file, "timestamp,actual_humidity,predicted_humidity,residual_error,temperature").unwrap();
        file
    };

    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let line = format!("{},{:.3},{:.3},{:.6},{:.2}\n", timestamp, actual, predicted, error, temperature);

    if let Err(e) = file.write_all(line.as_bytes()) {
        eprintln!("⚠ Gagal menulis ke CSV: {}", e);
    }
}

fn start_serial_reader(app_state: web::Data<AppState>) {
    thread::spawn(move || {
        let port_name = "COM7";
        let baud_rate = 9600;

        match serialport::new(port_name, baud_rate)
            .timeout(Duration::from_secs(1))
            .open() {
            Ok(mut port) => {
                println!("✅ Serial port berhasil dibuka");
                let mut buffer: Vec<u8> = vec![0; 64];

                loop {
                    match port.read(&mut buffer) {
                        Ok(n) => {
                            let input = String::from_utf8_lossy(&buffer[..n]).to_string();
                            println!("📥 Data diterima: '{}'", input.trim());
                            
                            let parts: Vec<&str> = input.trim().split(',').collect();
                            
                            if parts.len() == 2 {
                                if let (Ok(humidity), Ok(temperature)) = (
                                    parts[0].parse::<f32>(),
                                    parts[1].parse::<f32>()
                                ) {
                                    println!("✅ Data parsed: humidity={:.1}%, temp={:.1}°C", humidity, temperature);
                                    
                                    let mut data = app_state.sensor_data.lock().unwrap();
                                    data.humidity = humidity;
                                    data.temperature = temperature;
                                    
                                    let (predicted, _, _, _) = newton_raphson_prediction(humidity);
                                    let error = (humidity - predicted).abs();
                                    
                                    log_to_csv(humidity, predicted, error, temperature);
                                    println!("📊 Humidity: {:.1}% ({}), Temp: {:.1}°C", 
                                            humidity, get_humidity_status(humidity), temperature);
                                } else {
                                    eprintln!("⚠ Gagal parsing nilai humidity/temperature: '{}'", input.trim());
                                }
                            } else {
                                eprintln!("⚠ Format data tidak sesuai (harus: humidity,temperature): '{}'", input.trim());
                            }
                        }
                        Err(e) => {
                            eprintln!("❌ Error membaca serial: {}", e);
                        }
                    }

                    thread::sleep(Duration::from_millis(500));
                }
            }
            Err(e) => {
                eprintln!("❌ Gagal membuka port serial: {}", e);
                println!("🔄 Menggunakan data simulasi humidity...");
                
                // Fallback ke data simulasi humidity
                let mut counter: f64 = 0.0;
                loop {
                    let humidity = 50.0 + 20.0 * (counter * 0.05).sin();
                    let temperature = 25.0 + 5.0 * (counter * 0.03).cos();
                    
                    let mut data = app_state.sensor_data.lock().unwrap();
                    data.humidity = humidity as f32;
                    data.temperature = temperature as f32;
                    
                    let (predicted, _, _, _) = newton_raphson_prediction(humidity as f32);
                    let error = (humidity as f32 - predicted).abs();
                    
                    log_to_csv(humidity as f32, predicted, error, temperature as f32);
                    println!("📊 Humidity: {:.1}% ({}), Temp: {:.1}°C", 
                            humidity, get_humidity_status(humidity as f32), temperature);
                    
                    counter += 0.1;
                    thread::sleep(Duration::from_secs(2));
                }
            }
        }
    });
}

// Fungsi untuk mengembalikan hasil model termasuk perhitungan Newton-Raphson lengkap
async fn get_model_result(data: web::Data<AppState>) -> impl Responder {
    let data = data.sensor_data.lock().unwrap();
    let actual_humidity = data.humidity;

    // Hitung prediksi menggunakan Newton-Raphson
    let (predicted_humidity, steps, iterations, convergence_status) = 
        newton_raphson_prediction(actual_humidity);

    // Hitung residual error
    let residual_error = (actual_humidity - predicted_humidity).abs();

    // Menggunakan fungsi get_humidity_status untuk mendapatkan status kondisi
    let humidity_status = get_humidity_status(actual_humidity);

    let result = ModelResult {
        actual_humidity,
        predicted_humidity,
        humidity_status: humidity_status.to_string(),
        residual_error,
        newton_raphson_steps: steps,
        iterations,
        convergence_status,
    };

    HttpResponse::Ok().json(result)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();

    let sensor_data = SensorData { 
        humidity: 0.0,
        temperature: 0.0 
    };
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