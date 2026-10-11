<script setup lang="ts">
import { ref, watch } from 'vue'
import type { InstallmentResult } from '../../shared/loan'
import { calculateInstallments, createLoanApplication } from '../services/loanService'

const emit = defineEmits<{
  created: []
}>()

const applicantName = ref('')
const amount = ref<number | null>(null)
const termMonths = ref<number | null>(null)
const interestRate = ref<number | null>(null)
const error = ref('')
const installments = ref<InstallmentResult | null>(null)
const showSchedule = ref(false)

// Ask the API for the installment preview while the officer fills in the form
let previewTimer: number | undefined
watch([applicantName, amount, termMonths, interestRate], () => {
  globalThis.clearTimeout(previewTimer)
  installments.value = null
  const complete =
    applicantName.value.trim() &&
    amount.value &&
    amount.value > 0 &&
    termMonths.value &&
    termMonths.value > 0 &&
    interestRate.value !== null &&
    interestRate.value >= 0 &&
    interestRate.value <= 1
  if (!complete) return
  previewTimer = globalThis.setTimeout(async () => {
    try {
      installments.value = await calculateInstallments({
        applicantName: applicantName.value.trim(),
        amount: amount.value!,
        termMonths: termMonths.value!,
        interestRate: interestRate.value!,
        requestedAt: new Date().toISOString()
      })
    } catch {
      installments.value = null
    }
  }, 300)
})

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

async function handleSubmit() {
  error.value = ''

  // Basic validation
  if (!applicantName.value.trim()) {
    error.value = 'Applicant name is required'
    return
  }
  if (!amount.value || amount.value <= 0) {
    error.value = 'Amount must be greater than 0'
    return
  }
  if (!termMonths.value || termMonths.value <= 0) {
    error.value = 'Term months must be greater than 0'
    return
  }
  if (interestRate.value === null || interestRate.value < 0) {
    error.value = 'Interest rate is required and cannot be negative'
    return
  }

  try {
    await createLoanApplication({
      applicantName: applicantName.value.trim(),
      amount: amount.value,
      termMonths: termMonths.value,
      interestRate: interestRate.value
    })

    // Reset form
    applicantName.value = ''
    amount.value = null
    termMonths.value = null
    interestRate.value = null
    installments.value = null

    // Notify parent
    emit('created')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to create loan application'
  }
}
</script>

<template>
  <div class="loan-form card">
    <h2>New Loan Application</h2>
    
    <form @submit.prevent="handleSubmit">
      <div class="form-group">
        <label for="applicantName">Applicant Name</label>
        <input
          id="applicantName"
          v-model="applicantName"
          type="text"
          placeholder="Enter applicant name"
          required
        />
      </div>

      <div class="form-group">
        <label for="amount">Loan Amount ($)</label>
        <input
          id="amount"
          v-model.number="amount"
          type="number"
          min="1"
          step="1"
          placeholder="Enter loan amount"
          required
        />
      </div>

      <div class="form-group">
        <label for="termMonths">Term (Months)</label>
        <input
          id="termMonths"
          v-model.number="termMonths"
          type="number"
          min="1"
          step="1"
          placeholder="Enter term in months"
          required
        />
      </div>

      <div class="form-group">
        <label for="interestRate">Interest Rate (e.g., 0.08 for 8%)</label>
        <input
          id="interestRate"
          v-model.number="interestRate"
          type="number"
          min="0"
          max="1"
          step="0.001"
          placeholder="Enter interest rate"
          required
        />
      </div>

      <div v-if="installments" class="installment-preview">
        <div class="installment-headline">
          <span>Monthly installment</span>
          <strong>{{ formatCurrency(installments.monthlyPayment) }}</strong>
        </div>
        <div class="installment-total">
          Total repayable {{ formatCurrency(installments.totalRepayable) }}
          (interest {{ formatCurrency(installments.totalInterest) }})
        </div>
        <button type="button" class="link-btn" @click="showSchedule = !showSchedule">
          {{ showSchedule ? 'Hide' : 'Show' }} schedule ({{ installments.schedule.length }} months)
        </button>
        <table v-if="showSchedule" class="schedule">
          <thead>
            <tr><th>#</th><th>Due</th><th>Payment</th><th>Principal</th><th>Interest</th><th>Balance</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in installments.schedule" :key="row.month">
              <td>{{ row.month }}</td>
              <td>{{ row.dueDate }}</td>
              <td>{{ formatCurrency(row.payment) }}</td>
              <td>{{ formatCurrency(row.principal) }}</td>
              <td>{{ formatCurrency(row.interest) }}</td>
              <td>{{ formatCurrency(row.balance) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="error" class="error-message">
        {{ error }}
      </div>

      <button type="submit" class="primary submit-btn">
        Create Application
      </button>
    </form>
  </div>
</template>

<style scoped>
.loan-form {
  max-width: 400px;
}

.form-group {
  margin-bottom: 1rem;
}

.submit-btn {
  width: 100%;
  margin-top: 0.5rem;
}

.installment-preview {
  background-color: #f1f5f9;
  border-radius: var(--border-radius);
  padding: 0.75rem;
  margin-bottom: 1rem;
  font-size: 0.9rem;
}

.installment-headline {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.installment-headline strong {
  font-size: 1.25rem;
}

.installment-total {
  color: var(--text-secondary);
  font-size: 0.8rem;
  margin: 0.25rem 0 0.5rem;
}

.link-btn {
  background: none;
  border: none;
  padding: 0;
  color: var(--primary-color);
  cursor: pointer;
  font-size: 0.8rem;
  text-decoration: underline;
}

.schedule {
  width: 100%;
  margin-top: 0.5rem;
  font-size: 0.75rem;
  border-collapse: collapse;
}

.schedule th,
.schedule td {
  text-align: right;
  padding: 0.15rem 0.3rem;
  border-bottom: 1px solid #e2e8f0;
}

.error-message {
  color: var(--danger-color);
  background-color: #f8d7da;
  border: 1px solid #f5c6cb;
  border-radius: var(--border-radius);
  padding: 0.75rem;
  margin-bottom: 1rem;
}
</style>
