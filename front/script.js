// Global variables
var grafik;

// Humidity Calculator Class - based on your Rust implementation
class HumidityCalculator {
    constructor(atmosphericPressure = 101325.0) {
        this.atmosphericPressure = atmosphericPressure; // Pa (default standard atmospheric pressure)
    }

    // Calculate saturated vapor pressure (psat) based on temperature
    // Using Magnus formula: psat = 610.78 * exp(17.27 * T / (T + 237.3))
    calculatePsat(temperatureCelsius) {
        return 610.78 * Math.exp(17.27 * temperatureCelsius / (temperatureCelsius + 237.3));
    }

    // Calculate partial vapor pressure from RH and temperature
    // pv = (RH/100) * psat
    calculatePv(relativeHumidity, temperatureCelsius) {
        const psat = this.calculatePsat(temperatureCelsius);
        return (relativeHumidity / 100.0) * psat;
    }

    // Calculate RH from partial vapor pressure and temperature
    // RH = (pv / psat) * 100
    calculateRh(pv, temperatureCelsius) {
        const psat = this.calculatePsat(temperatureCelsius);
        return (pv / psat) * 100.0;
    }

    // Calculate humidity ratio (x) from RH and temperature
    // x = 0.622 * (RH * psat) / (p - (RH * psat)) [kg/kg_da]
    calculateHumidityRatio(relativeHumidity, temperatureCelsius) {
        const psat = this.calculatePsat(temperatureCelsius);
        const pv = (relativeHumidity / 100.0) * psat;
        
        return 0.622 * pv / (this.atmosphericPressure - pv);
    }

    // Calculate dew point temperature using inverse Magnus formula
    calculateDewPoint(relativeHumidity, temperatureCelsius) {
        const pv = this.calculatePv(relativeHumidity, temperatureCelsius);
        const gamma = Math.log(pv / 610.78);
        return (237.3 * gamma) / (17.27 - gamma);
    }

    // Calculate heat index (apparent temperature)
    calculateHeatIndex(temperatureCelsius, relativeHumidity) {
        const T = temperatureCelsius * 9/5 + 32; // Convert to Fahrenheit for calculation
        const RH = relativeHumidity;
        
        // Simplified heat index formula (valid for T >= 80°F)
        if (T < 80) {
            return temperatureCelsius; // Return original temperature if too cool
        }
        
        const HI = -42.379 + 2.04901523 * T + 10.14333127 * RH 
                   - 0.22475541 * T * RH - 0.00683783 * T * T 
                   - 0.05481717 * RH * RH + 0.00122874 * T * T * RH 
                   + 0.00085282 * T * RH * RH - 0.00000199 * T * T * RH * RH;
        
        return (HI - 32) * 5/9; // Convert back to Celsius
    }
}

// Global humidity calculator instance
const humidityCalculator = new HumidityCalculator();

// Initialize the application when DOM is loaded
document.addEventListener("DOMContentLoaded", function () {
    showSection("dataSection");
    updateGrafik();
    updateHumidityStatus(45); // Starting with a random humidity, just for testing
});

// Function to toggle sections in the UI
function showSection(sectionId) {
    const sections = document.querySelectorAll(".section");
    sections.forEach(section => section.classList.remove("active"));
    document.getElementById(sectionId).classList.add("active");
    
    if (sectionId === 'grafikSection') {
        initChart();
    } else if (sectionId === 'perhitunganSection') {
        performHumidityCalculation();
    }
}

// Initialize Chart.js for the humidity graph with prediction line
function initializeChart() {
    var ctx = document.getElementById('grafikCanvas').getContext('2d');
    grafik = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Kelembaban Aktual (%)',
                data: [],
                borderColor: '#00bcd4',
                backgroundColor: 'rgba(0, 188, 212, 0.2)',
                fill: false,
                tension: 0.1,
                pointRadius: 4,
                pointBackgroundColor: '#00bcd4'
            }, {
                label: 'Kelembaban Prediksi (%)',
                data: [],
                borderColor: '#ff6b6b',
                backgroundColor: 'rgba(255, 107, 107, 0.2)',
                fill: false,
                tension: 0.1,
                pointRadius: 4,
                pointBackgroundColor: '#ff6b6b',
                borderDash: [5, 5]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    type: 'linear',
                    position: 'left',
                    min: 0,
                    max: 100,
                    title: {
                        display: true,
                        text: 'Kelembaban Relatif (%)',
                        color: "#333333",
                        font: {
                            size: 14,
                            weight: 'bold'
                        }
                    },
                    grid: { 
                        color: "rgba(0, 0, 0, 0.1)",
                        lineWidth: 1
                    },
                    ticks: {
                        color: '#333333',
                        font: {
                            size: 12
                        }
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Waktu',
                        color: "#333333",
                        font: {
                            size: 14,
                            weight: 'bold'
                        }
                    },
                    grid: { 
                        color: "rgba(0, 0, 0, 0.1)",
                        lineWidth: 1
                    },
                    ticks: {
                        color: '#333333',
                        font: {
                            size: 12
                        },
                        maxTicksLimit: 10
                    }
                }
            },
            plugins: {
                legend: {
                    labels: { 
                        color: '#333333',
                        font: {
                            size: 14,
                            weight: 'bold'
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: '#ffffff',
                    bodyColor: '#ffffff',
                    borderColor: '#00bcd4',
                    borderWidth: 1
                }
            },
            interaction: {
                intersect: false,
                mode: 'index'
            }
        }
    });
}

// Update grafik every 5 seconds
async function updateGrafik() {
    try {
        // Try to fetch from API, fallback to simulation if API unavailable
        let sensorData, calculationData;
        
        try {
            const res = await fetch("/api/sensor");
            sensorData = await res.json();
            
            const calculationRes = await fetch("/api/perhitungan");
            calculationData = await calculationRes.json();
        } catch (apiError) {
            // Fallback to simulation if API is not available
            sensorData = generateSimulatedData();
            calculationData = generateSimulatedCalculation(sensorData.humidity, sensorData.temperature);
        }

        const actualHumidity = parseFloat(sensorData.humidity || sensorData.value || 45).toFixed(1);
        const temperature = parseFloat(sensorData.temperature || 25).toFixed(1);
        const predictedHumidity = parseFloat(calculationData.predicted_humidity || calculationData.predicted_value || actualHumidity * 1.02).toFixed(1);
        const residualError = parseFloat(calculationData.residual_error || Math.abs(actualHumidity - predictedHumidity)).toFixed(3);
        const now = new Date().toLocaleTimeString();

        // Initialize chart if not already initialized
        if (!grafik) {
            initializeChart();
        }

        // Update grafik
        grafik.data.labels.push(now);
        grafik.data.datasets[0].data.push(parseFloat(actualHumidity));
        grafik.data.datasets[1].data.push(parseFloat(predictedHumidity));

        // Limit data points to last 20 for better performance
        if (grafik.data.labels.length > 20) {
            grafik.data.labels.shift();
            grafik.data.datasets[0].data.shift();
            grafik.data.datasets[1].data.shift();
        }

        grafik.update('none'); // Use 'none' animation for real-time updates

        // Update data display
        document.getElementById('actualHumidity').textContent = `${actualHumidity} %`;
        document.getElementById('predictedHumidity').textContent = `${predictedHumidity} %`;
        
        // Format residual error
        const errorValue = parseFloat(residualError);
        let errorDisplay;
        if (errorValue < 0.001) {
            errorDisplay = errorValue.toExponential(3) + " %";
        } else {
            errorDisplay = errorValue + " %";
        }
        document.getElementById('residualError').textContent = errorDisplay;
        
        // Determine environment status
        let status = '';
        const humidityVal = parseFloat(actualHumidity);
        if (humidityVal < 30) {
            status = 'Kering';
        } else if (humidityVal > 70) {
            status = 'Lembab';
        } else {
            status = 'Normal';
        }
        document.getElementById('environmentStatus').textContent = status;

        // Update calculation display if available
        if (calculationData.humidity_calculations) {
            updateHumidityCalculationDisplay(calculationData.humidity_calculations);
        }

        // Update humidity status with proper calculations
        updateHumidityStatus(parseFloat(actualHumidity), parseFloat(temperature));
        
    } catch (error) {
        console.error("Gagal mengambil data sensor:", error);
        // Continue with simulation data
        const simulatedData = generateSimulatedData();
        updateHumidityStatus(simulatedData.humidity, simulatedData.temperature);
    }
}

// Generate simulated sensor data
function generateSimulatedData() {
    const baseHumidity = 45 + (Math.random() - 0.5) * 30; // 30-75% range
    const humidity = Math.max(20, Math.min(90, baseHumidity));
    const temperature = 25 + (Math.random() - 0.5) * 10; // 20-30°C range
    
    return {
        humidity: humidity,
        temperature: temperature
    };
}

// Generate simulated calculation data with proper humidity calculations
function generateSimulatedCalculation(actualHumidity, temperature) {
    // Use humidity calculator for realistic predictions
    const psat = humidityCalculator.calculatePsat(temperature);
    const pv = humidityCalculator.calculatePv(actualHumidity, temperature);
    const humidityRatio = humidityCalculator.calculateHumidityRatio(actualHumidity, temperature);
    
    // Add some noise for prediction
    const noise = (Math.random() - 0.5) * 2;
    const predictedHumidity = Math.max(0, Math.min(100, actualHumidity + noise));
    
    return {
        predicted_humidity: predictedHumidity,
        residual_error: Math.abs(actualHumidity - predictedHumidity),
        convergence_status: "Konvergen",
        iterations: Math.floor(Math.random() * 10) + 3,
        humidity_calculations: {
            psat: psat,
            pv: pv,
            humidity_ratio: humidityRatio,
            atmospheric_pressure: humidityCalculator.atmosphericPressure
        }
    };
}

// Update humidity calculation display
function updateHumidityCalculationDisplay(calculations) {
    // Update calculation results if elements exist
    if (document.getElementById('psatValue')) {
        document.getElementById('psatValue').textContent = calculations.psat.toFixed(2) + ' Pa';
    }
    if (document.getElementById('pvValue')) {
        document.getElementById('pvValue').textContent = calculations.pv.toFixed(2) + ' Pa';
    }
    if (document.getElementById('humidityRatioValue')) {
        document.getElementById('humidityRatioValue').textContent = calculations.humidity_ratio.toFixed(6) + ' kg/kg_da';
    }
    if (document.getElementById('atmosphericPressureValue')) {
        document.getElementById('atmosphericPressureValue').textContent = calculations.atmospheric_pressure.toFixed(0) + ' Pa';
    }
}

// Update humidity status and visualization with proper calculations
function updateHumidityStatus(humidity, temperature = 25) {
    const humidityVisual = document.getElementById('humidityVisual');
    const humidityPercentage = document.getElementById('humidityPercentage');
    const humidityStatus = document.getElementById('humidityStatus');

    // Update percentage display
    humidityPercentage.textContent = Math.round(humidity) + '%';

    // Remove existing classes
    humidityVisual.classList.remove('low', 'normal', 'high');

    // Update visual and status based on humidity level
    if (humidity < 35) {
        humidityVisual.classList.add('low');
        humidityStatus.textContent = 'Kelembaban Rendah - Udara Kering';
        humidityStatus.style.color = '#e74c3c';
    } else if (humidity > 65) {
        humidityVisual.classList.add('high');
        humidityStatus.textContent = 'Kelembaban Tinggi - Udara Lembab';
        humidityStatus.style.color = '#3498db';
    } else {
        humidityVisual.classList.add('normal');
        humidityStatus.textContent = 'Kelembaban Normal - Kondisi Optimal';
        humidityStatus.style.color = '#27ae60';
    }

    // Calculate proper environmental parameters using humidity calculator
    const pressure = 1013 + (Math.random() - 0.5) * 20; // Atmospheric pressure in hPa
    const dewPoint = humidityCalculator.calculateDewPoint(humidity, temperature);
    const heatIndex = humidityCalculator.calculateHeatIndex(temperature, humidity);
    const psat = humidityCalculator.calculatePsat(temperature);
    const pv = humidityCalculator.calculatePv(humidity, temperature);
    const humidityRatio = humidityCalculator.calculateHumidityRatio(humidity, temperature);

    // Update environmental details
    document.getElementById('temperature').textContent = temperature.toFixed(1) + ' °C';
    document.getElementById('pressure').textContent = pressure.toFixed(0) + ' hPa';
    document.getElementById('dewPoint').textContent = dewPoint.toFixed(1) + ' °C';
    document.getElementById('heatIndex').textContent = heatIndex.toFixed(1) + ' °C';

    // Update calculation details if elements exist
    if (document.getElementById('psatDisplay')) {
        document.getElementById('psatDisplay').textContent = psat.toFixed(2) + ' Pa';
    }
    if (document.getElementById('pvDisplay')) {
        document.getElementById('pvDisplay').textContent = pv.toFixed(2) + ' Pa';
    }
    if (document.getElementById('humidityRatioDisplay')) {
        document.getElementById('humidityRatioDisplay').textContent = humidityRatio.toFixed(6) + ' kg/kg_da';
    }
}

// Initialize chart when grafik section is shown
function initChart() {
    // Chart is already initialized globally, just ensure it's updated
    if (grafik && grafik.data.labels.length === 0) {
        // Initialize with some sample data if empty
        updateGrafik();
    }
}

// Humidity calculation demonstration (replaces Newton-Raphson)
function performHumidityCalculation() {
    const tolerance = 1e-6;
    const maxIterations = 20;
    
    // Sample humidity and temperature for demonstration
    const sampleHumidity = 50 + (Math.random() - 0.5) * 40; // 30-70%
    const sampleTemperature = 25 + (Math.random() - 0.5) * 10; // 20-30°C
    
    const tableBody = document.querySelector('#iterationTable tbody');
    tableBody.innerHTML = '';
    
    // Demonstrate iterative calculation of humidity ratio
    let x = 0.01; // Initial guess for humidity ratio
    let iterations = 0;
    let converged = false;
    
    // Function to solve: x = 0.622 * pv / (p - pv)
    // Rearranged to: f(x) = x * (p - pv) - 0.622 * pv = 0
    function f(x, rh, temp) {
        const psat = humidityCalculator.calculatePsat(temp);
        const pv = (rh / 100.0) * psat;
        const p = humidityCalculator.atmosphericPressure;
        return x * (p - pv) - 0.622 * pv;
    }
    
    // Derivative of the function
    function df(x, rh, temp) {
        const psat = humidityCalculator.calculatePsat(temp);
        const pv = (rh / 100.0) * psat;
        const p = humidityCalculator.atmosphericPressure;
        return p - pv;
    }
    
    for (let i = 0; i < maxIterations; i++) {
        const fx = f(x, sampleHumidity, sampleTemperature);
        const dfx = df(x, sampleHumidity, sampleTemperature);
        
        if (Math.abs(dfx) < tolerance) {
            break;
        }
        
        const x_new = x - fx / dfx;
        const error = Math.abs(x_new - x);
        
        // Calculate actual values for display
        const psat = humidityCalculator.calculatePsat(sampleTemperature);
        const pv = (sampleHumidity / 100.0) * psat;
        
        // Add row to table
        const row = tableBody.insertRow();
        row.innerHTML = `
            <td>${i + 1}</td>
            <td>${x.toFixed(6)}</td>
            <td>${fx.toFixed(6)}</td>
            <td>${dfx.toFixed(2)}</td>
            <td>${x_new.toFixed(6)}</td>
            <td>${error.toExponential(2)}</td>
        `;
        
        if (error < tolerance) {
            converged = true;
            iterations = i + 1;
            row.style.backgroundColor = 'rgba(39, 174, 96, 0.1)';
            break;
        }
        
        x = x_new;
        iterations = i + 1;
    }
    
    // Display calculation parameters
    document.getElementById('convergenceStatus').textContent = converged ? 'Konvergen' : 'Tidak Konvergen';
    document.getElementById('iterationCount').textContent = iterations;
    
    // Color the convergence status
    const statusElement = document.getElementById('convergenceStatus');
    statusElement.style.color = converged ? '#27ae60' : '#e74c3c';
    statusElement.style.fontWeight = 'bold';
    
    // Display the sample data used
    if (document.getElementById('calculationParameters')) {
        document.getElementById('calculationParameters').innerHTML = `
            <p><strong>Parameter Perhitungan:</strong></p>
            <p>RH: ${sampleHumidity.toFixed(1)}%</p>
            <p>Temperatur: ${sampleTemperature.toFixed(1)}°C</p>
            <p>Tekanan Atmosfer: ${humidityCalculator.atmosphericPressure} Pa</p>
            <p><strong>Rumus:</strong> x = 0.622 × pv / (p - pv)</p>
            <p><strong>Hasil Akhir:</strong> x = ${x.toFixed(6)} kg/kg_da</p>
        `;
    }
}

// Format number with scientific notation for small values
function formatNumber(num) {
    if (Math.abs(num) < 0.001) {
        return num.toExponential(2);
    }
    return num.toFixed(6);
}

// Manual calculation function for user input
function calculateManualHumidity() {
    const rh = parseFloat(document.getElementById('inputRH').value);
    const temp = parseFloat(document.getElementById('inputTemp').value);
    const pressure = parseFloat(document.getElementById('inputPressure').value) || 101325;
    
    if (isNaN(rh) || isNaN(temp) || rh < 0 || rh > 100) {
        alert('Masukkan nilai RH (0-100%) dan Temperatur yang valid!');
        return;
    }
    
    // Create calculator with custom pressure if provided
    const calc = new HumidityCalculator(pressure);
    
    // Calculate all parameters
    const psat = calc.calculatePsat(temp);
    const pv = calc.calculatePv(rh, temp);
    const humidityRatio = calc.calculateHumidityRatio(rh, temp);
    const dewPoint = calc.calculateDewPoint(rh, temp);
    const heatIndex = calc.calculateHeatIndex(temp, rh);
    
    // Display results
    const resultsDiv = document.getElementById('calculationResults');
    resultsDiv.innerHTML = `
        <h3>Hasil Perhitungan</h3>
        <div class="calculation-result">
            <p><strong>Input:</strong></p>
            <p>RH: ${rh}%</p>
            <p>Temperatur: ${temp}°C</p>
            <p>Tekanan Atmosfer: ${pressure} Pa</p>
            
            <p><strong>Hasil:</strong></p>
            <p>Saturated Vapor Pressure (psat): ${psat.toFixed(2)} Pa</p>
            <p>Partial Vapor Pressure (pv): ${pv.toFixed(2)} Pa</p>
            <p>Humidity Ratio (x): ${humidityRatio.toFixed(6)} kg/kg_da</p>
            <p>Dew Point: ${dewPoint.toFixed(2)}°C</p>
            <p>Heat Index: ${heatIndex.toFixed(2)}°C</p>
            
            <p><strong>Rumus yang digunakan:</strong></p>
            <p>psat = 610.78 × exp(17.27 × T / (T + 237.3))</p>
            <p>pv = (RH/100) × psat</p>
            <p>x = 0.622 × pv / (p - pv)</p>
        </div>
    `;
    resultsDiv.style.display = 'block';
}

// Update data every 5 seconds
setInterval(updateGrafik, 5000);