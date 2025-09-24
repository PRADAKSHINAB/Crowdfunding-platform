// About section scroll animations
const aboutObserverOptions = {
    threshold: 0.2,
    rootMargin: '0px 0px -100px 0px'
};

const aboutObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('animate');
        }
    });
}, aboutObserverOptions);

// Wait for DOM to be fully loaded
document.addEventListener('DOMContentLoaded', () => {
    // Mobile Navigation Toggle (defensive programming)
    const hamburger = document.querySelector('.hamburger');
    const navMenu = document.querySelector('.nav-menu');

    if (hamburger && navMenu) {
        hamburger.addEventListener('click', () => {
            hamburger.classList.toggle('active');
            navMenu.classList.toggle('active');
        });

        // Close mobile menu when clicking on a link
        const navLinks = document.querySelectorAll('.nav-menu a');
        if (navLinks.length > 0) {
            navLinks.forEach(link => {
                link.addEventListener('click', () => {
                    hamburger.classList.remove('active');
                    navMenu.classList.remove('active');
                });
            });
        }
    }

// Smooth scrolling for anchor links (defensive programming)
const anchorLinks = document.querySelectorAll('a[href^="#"]');
if (anchorLinks.length > 0) {
    anchorLinks.forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const href = this.getAttribute('href');
            if (href && href !== '#') {
                const target = document.querySelector(href);
                if (target) {
                    target.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
            }
        });
    });
}

// Navbar background on scroll (defensive programming)
const navbar = document.querySelector('.navbar');
if (navbar) {
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            navbar.style.background = 'rgba(10, 10, 10, 0.98)';
        } else {
            navbar.style.background = 'rgba(10, 10, 10, 0.95)';
        }
    });
}

// Animate elements on scroll
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('animate');
        }
    });
}, observerOptions);

// About section scroll animations
const aboutObserverOptions = {
    threshold: 0.2,
    rootMargin: '0px 0px -100px 0px'
};

const aboutObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('animate');
        }
    });
}, aboutObserverOptions);

// Initialize About section animations
const initAboutAnimations = () => {
    const aboutText = document.querySelector('.about-text');
    const aboutImage = document.querySelector('.about-image');
    
    if (aboutText) {
        aboutObserver.observe(aboutText);
    }
    
    if (aboutImage) {
        aboutObserver.observe(aboutImage);
    }
};

// Initialize scroll animations for all sections
const initScrollAnimations = () => {
    // General scroll observer for multiple elements
    const scrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate');
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });

    // Observe How It Works steps
    const steps = document.querySelectorAll('.step');
    steps.forEach((step, index) => {
        step.style.opacity = '0';
        step.style.transform = 'translateY(30px)';
        step.style.transition = `opacity 0.6s ease ${index * 0.2}s, transform 0.6s ease ${index * 0.2}s`;
        scrollObserver.observe(step);
    });

    // Observe featured campaign cards
    const campaignCards = document.querySelectorAll('.campaign-card');
    campaignCards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        card.style.transition = `opacity 0.6s ease ${index * 0.1}s, transform 0.6s ease ${index * 0.1}s`;
        scrollObserver.observe(card);
    });

    // Observe section titles
    const sectionTitles = document.querySelectorAll('.how-it-works h2, .featured-campaigns h2');
    sectionTitles.forEach(title => {
        title.style.opacity = '0';
        title.style.transform = 'translateY(-20px)';
        title.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        scrollObserver.observe(title);
    });
};

// Initialize animations after DOM is loaded
    initAboutAnimations();
    initScrollAnimations();
    
    // Observe elements for animation (defensive programming)
const animateElements = document.querySelectorAll('.campaign-card, .step, .stat');
if (animateElements.length > 0) {
    animateElements.forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(el);
    });
}

// Progress bar animation
const animateProgressBars = () => {
    const progressBars = document.querySelectorAll('.progress-fill');
    if (progressBars.length > 0) {
        progressBars.forEach(bar => {
            const width = bar.style.width;
            bar.style.width = '0%';
            setTimeout(() => {
                bar.style.width = width;
            }, 200);
        });
    }
};

// Animate progress bars when they come into view
const progressObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            animateProgressBars();
        }
    });
}, { threshold: 0.5 });

const campaignProgressElements = document.querySelectorAll('.campaign-progress');
if (campaignProgressElements.length > 0) {
    campaignProgressElements.forEach(el => {
        progressObserver.observe(el);
    });
}

// Newsletter form handling (defensive programming)
const newsletterForm = document.querySelector('.newsletter');
if (newsletterForm) {
    newsletterForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const emailInput = e.target.querySelector('input[type="email"]');
        if (emailInput) {
            const email = emailInput.value;
            if (email && isValidEmail(email)) {
                showNotification('Thank you for subscribing!', 'success');
                e.target.reset();
            } else {
                showNotification('Please enter a valid email address.', 'error');
            }
        }
    });
}

// Email validation helper
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// Notification system
function showNotification(message, type) {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    // Style the notification
    Object.assign(notification.style, {
        position: 'fixed',
        top: '20px',
        right: '20px',
        padding: '15px 25px',
        borderRadius: '5px',
        color: 'white',
        fontWeight: '500',
        zIndex: '10000',
        transform: 'translateX(100%)',
        transition: 'transform 0.3s ease',
        maxWidth: '300px'
    });
    
    if (type === 'success') {
        notification.style.backgroundColor = 'var(--success-green)';
    } else {
        notification.style.backgroundColor = 'var(--warning-orange)';
    }
    
    document.body.appendChild(notification);
    
    // Animate in
    setTimeout(() => {
        notification.style.transform = 'translateX(0)';
    }, 100);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 300);
    }, 3000);
}

// Campaign data (mock data for demonstration)
const campaigns = [
    {
        id: 1,
        title: "Eco-Friendly Community Garden",
        description: "Creating a sustainable green space for urban farming and education.",
        image: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400&h=250&fit=crop",
        goal: 20000,
        raised: 15000,
        daysLeft: 12,
        backers: 234,
        badge: "Trending"
    },
    {
        id: 2,
        title: "Portable Solar Power Bank",
        description: "Revolutionary solar-powered charging solution for outdoor enthusiasts.",
        image: "https://images.unsplash.com/photo-1497435334941-8c899ee9e8e9?w=400&h=250&fit=crop",
        goal: 100000,
        raised: 45000,
        daysLeft: 28,
        backers: 567,
        badge: "New"
    },
    {
        id: 3,
        title: "Smart Home Garden System",
        description: "AI-powered indoor garden that grows fresh herbs and vegetables automatically.",
        image: "https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=400&h=250&fit=crop",
        goal: 200000,
        raised: 180000,
        daysLeft: 5,
        backers: 1234,
        badge: "Popular"
    }
];

// Function to create campaign cards dynamically
function createCampaignCard(campaign) {
    const progress = (campaign.raised / campaign.goal) * 100;
    
    return `
        <div class="campaign-card">
            <div class="campaign-image">
                <img src="${campaign.image}" alt="${campaign.title}">
                <div class="campaign-badge">${campaign.badge}</div>
            </div>
            <div class="campaign-content">
                <h3>${campaign.title}</h3>
                <p>${campaign.description}</p>
                <div class="campaign-progress">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${progress}%"></div>
                    </div>
                    <div class="progress-stats">
                        <span>$${campaign.raised.toLocaleString()} raised</span>
                        <span>${Math.round(progress)}% of $${campaign.goal.toLocaleString()}</span>
                    </div>
                </div>
                <div class="campaign-meta">
                    <span><i class="fas fa-clock"></i> ${campaign.daysLeft} days left</span>
                    <span><i class="fas fa-users"></i> ${campaign.backers} backers</span>
                </div>
            </div>
        </div>
    `;
}



// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Add hover effects to campaign cards (defensive programming)
    const campaignCards = document.querySelectorAll('.campaign-card');
    if (campaignCards.length > 0) {
        campaignCards.forEach(card => {
            card.addEventListener('mouseenter', () => {
                card.style.transform = 'translateY(-5px) scale(1.02)';
            });
            
            card.addEventListener('mouseleave', () => {
                card.style.transform = 'translateY(0) scale(1)';
            });
        });
    }
    
    // Animate about counters if they exist
    animateAboutCounters();
});

// Parallax effect for hero section
window.addEventListener('scroll', () => {
    const scrolled = window.pageYOffset;
    const hero = document.querySelector('.hero');
    if (hero) {
        hero.style.transform = `translateY(${scrolled * 0.5}px)`;
    }
});

// Add loading animation for images (defensive programming)
document.addEventListener('DOMContentLoaded', () => {
    const images = document.querySelectorAll('img');
    if (images.length > 0) {
        images.forEach(img => {
            img.addEventListener('load', () => {
                img.style.opacity = '1';
            });
            img.style.opacity = '0';
            img.style.transition = 'opacity 0.3s ease';
        });
    }
});

// Counter animation for hero stats (if they exist)
function animateCounters() {
    const counters = document.querySelectorAll('.stat h3');
    if (counters.length > 0) {
        counters.forEach(counter => {
            const textContent = counter.textContent || '';
            const target = parseInt(textContent.replace(/[^\d]/g, ''));
            const suffix = textContent.replace(/[\d]/g, '');
            
            if (!isNaN(target)) {
                let current = 0;
                const increment = target / 100;
                
                const timer = setInterval(() => {
                    current += increment;
                    counter.textContent = Math.floor(current) + suffix;
                    
                    if (current >= target) {
                        counter.textContent = target + suffix;
                        clearInterval(timer);
                    }
                }, 20);
            }
        });
    }
}

// Animate stats on scroll
function animateStats() {
    const stats = document.querySelectorAll('.stat-item');
    if (!stats.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const statNumber = entry.target.querySelector('.stat-number');
                const target = parseInt(statNumber.getAttribute('data-count'));
                animateCounter(statNumber, target);
                observer.unobserve(entry.target);
            }
        });
    });

    stats.forEach(stat => observer.observe(stat));
}

function animateAboutCounters() {
    const counters = document.querySelectorAll('.stat-number[data-count]');
    if (!counters.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const element = entry.target;
                const target = parseInt(element.getAttribute('data-count'));
                const suffix = element.textContent.includes('%') ? '%' : '';
                
                let current = 0;
                const increment = target / 100;
                const timer = setInterval(() => {
                    current += increment;
                    if (current >= target) {
                        element.textContent = target.toLocaleString() + suffix;
                        clearInterval(timer);
                    } else {
                        element.textContent = Math.floor(current).toLocaleString() + suffix;
                    }
                }, 20);
                
                observer.unobserve(element);
            }
        });
    });

    counters.forEach(counter => observer.observe(counter));
}

function animateCounter(element, target) {
    let current = 0;
    const increment = target / 100;
    const timer = setInterval(() => {
        current += increment;
        if (current >= target) {
            element.textContent = target.toLocaleString();
            clearInterval(timer);
        } else {
            element.textContent = Math.floor(current).toLocaleString();
        }
    }, 20);
}

// Trigger counter animation when hero stats come into view (defensive programming)
const heroStats = document.querySelector('.hero-stats');
if (heroStats) {
    const counterObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                animateCounters();
            }
        });
    }, { threshold: 0.5 });
    counterObserver.observe(heroStats);
}

})
